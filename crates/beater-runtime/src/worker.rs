//! The JS worker: one dedicated OS thread owning a `JsRuntime` (it is !Send),
//! driven by a current-thread tokio runtime. The host talks to it over an
//! mpsc channel — the protocol is already pool-shaped for N workers later.

use std::rc::Rc;

use anyhow::{Context, Result};
use deno_core::error::{CoreError, CoreErrorKind, JsError};
use deno_core::{JsRuntime, PollEventLoopOptions, RuntimeOptions, extension, op2, v8};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};

use crate::loader::BeaterModuleLoader;

#[derive(Debug)]
pub enum WorkerMsg {
    Route {
        /// file:// specifier of the route module.
        specifier: String,
        /// Uppercase HTTP method (picks the module export).
        method: String,
        /// JSON-serialized request object passed to the handler.
        request_json: String,
        reply: oneshot::Sender<Result<RouteResponse, String>>,
    },
}

#[derive(Debug, Deserialize)]
pub struct RouteResponse {
    pub status: u16,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub body: String,
}

#[op2(async(lazy), fast)]
async fn op_beater_sleep(ms: f64) {
    tokio::time::sleep(std::time::Duration::from_millis(ms.max(0.0) as u64)).await;
}

// generated struct is pub; used by worker + agent_config isolates
extension!(beater_ext, ops = [op_beater_sleep]);

pub struct WorkerHandle {
    pub tx: mpsc::Sender<WorkerMsg>,
}

/// Spawn a fresh isolate on its own thread. Dropping the last sender shuts
/// the worker down after it drains in-flight messages.
pub fn spawn() -> Result<WorkerHandle> {
    let (tx, rx) = mpsc::channel::<WorkerMsg>(64);
    std::thread::Builder::new()
        .name("beater-js".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("worker tokio runtime");
            let local = tokio::task::LocalSet::new();
            local.block_on(&rt, worker_main(rx));
        })
        .context("spawn js worker thread")?;
    Ok(WorkerHandle { tx })
}

async fn worker_main(mut rx: mpsc::Receiver<WorkerMsg>) {
    let mut runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(BeaterModuleLoader)),
        extensions: vec![beater_ext::init()],
        ..Default::default()
    });
    runtime
        .execute_script("beater:bootstrap", include_str!("bootstrap.js"))
        .expect("bootstrap.js must evaluate");
    tracing::debug!("js worker ready (V8 {})", v8::VERSION_STRING);

    while let Some(msg) = rx.recv().await {
        match msg {
            WorkerMsg::Route {
                specifier,
                method,
                request_json,
                reply,
            } => {
                let result = dispatch(&mut runtime, &specifier, &method, &request_json).await;
                let _ = reply.send(result);
            }
        }
    }
    tracing::debug!("js worker shutting down");
}

async fn dispatch(
    runtime: &mut JsRuntime,
    specifier: &str,
    method: &str,
    request_json: &str,
) -> Result<RouteResponse, String> {
    let code = format!(
        "globalThis.__beaterDispatch({}, {}, {})",
        serde_json::Value::String(specifier.to_string()),
        serde_json::Value::String(method.to_string()),
        request_json,
    );
    let promise = runtime
        .execute_script("beater:dispatch", code)
        .map_err(|e| format_js_error(&e))?;
    let resolved = runtime.resolve(promise);
    let global = runtime
        .with_event_loop_promise(resolved, PollEventLoopOptions::default())
        .await
        .map_err(format_core_error)?;

    deno_core::scope!(scope, runtime);
    let local = v8::Local::new(scope, global);
    let response: RouteResponse = deno_core::serde_v8::from_v8(scope, local)
        .map_err(|e| format!("route response did not match {{ status, headers, body }}: {e}"))?;
    Ok(response)
}

/// Render a JS exception with its (source-mapped) stack for dev output.
pub(crate) fn format_js_error(err: &JsError) -> String {
    match &err.stack {
        Some(stack) if !stack.is_empty() => stack.clone(),
        _ => err.exception_message.clone(),
    }
}

fn format_core_error(err: CoreError) -> String {
    match *err.0 {
        CoreErrorKind::Js(js) => format_js_error(&js),
        other => format!("{other}"),
    }
}
