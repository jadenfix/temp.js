//! The dev server: axum in front, JS worker behind a swappable channel,
//! notify-based hot reload that replaces the whole isolate.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, Response, StatusCode};
use axum::routing::Router;
use serde_json::json;
use tokio::sync::{RwLock, mpsc, oneshot};

use crate::config::AppConfig;
use crate::router::{RouteKind, RouteTable};
use crate::worker::{self, WorkerMsg};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
struct DevState {
    routes: Arc<RwLock<RouteTable>>,
    worker_tx: Arc<RwLock<mpsc::Sender<WorkerMsg>>>,
}

pub async fn serve(config: AppConfig, port: u16) -> Result<()> {
    let table = RouteTable::scan(&config.app_dir)?;
    if table.is_empty() {
        tracing::warn!("no routes found under {}/app/routes", config.app_dir.display());
    }
    for route in table.iter() {
        tracing::info!("route {} -> {}", route.pattern, route.file.display());
    }

    let worker = worker::spawn()?;
    let state = DevState {
        routes: Arc::new(RwLock::new(table)),
        worker_tx: Arc::new(RwLock::new(worker.tx)),
    };

    spawn_reloader(config.app_dir.clone(), state.clone());

    let app = Router::new().fallback(handle).with_state(state);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    tracing::info!("beater dev listening on http://{addr} (app: {})", config.name);

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await?;
    Ok(())
}

/// Watch app/ and agents/; on change, rescan routes and swap in a fresh
/// isolate. The old worker drains and exits when its channel closes.
fn spawn_reloader(app_dir: PathBuf, state: DevState) {
    let (tx, mut rx) = mpsc::channel::<()>(16);
    let watch_dir = app_dir.clone();
    std::thread::spawn(move || {
        use notify::Watcher;
        let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if event.kind.is_modify() || event.kind.is_create() || event.kind.is_remove() {
                    let _ = tx.blocking_send(());
                }
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                tracing::error!("watcher failed to start: {e}");
                return;
            }
        };
        for sub in ["app", "agents"] {
            let dir = watch_dir.join(sub);
            if dir.is_dir() {
                if let Err(e) = watcher.watch(&dir, notify::RecursiveMode::Recursive) {
                    tracing::error!("watch {}: {e}", dir.display());
                }
            }
        }
        // keep the watcher alive forever; the dev process owns its lifetime
        std::thread::park();
    });

    tokio::spawn(async move {
        while rx.recv().await.is_some() {
            // debounce editor save bursts
            tokio::time::sleep(Duration::from_millis(120)).await;
            while rx.try_recv().is_ok() {}
            match (RouteTable::scan(&app_dir), worker::spawn()) {
                (Ok(table), Ok(worker)) => {
                    *state.routes.write().await = table;
                    *state.worker_tx.write().await = worker.tx;
                    tracing::info!("reloaded (fresh isolate)");
                }
                (Err(e), _) => tracing::error!("reload: route scan failed: {e:#}"),
                (_, Err(e)) => tracing::error!("reload: worker spawn failed: {e:#}"),
            }
        }
    });
}

async fn handle(State(state): State<DevState>, req: Request<Body>) -> Response<Body> {
    match handle_inner(state, req).await {
        Ok(resp) => resp,
        Err(e) => text_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("beater internal error: {e:#}"),
        ),
    }
}

async fn handle_inner(state: DevState, req: Request<Body>) -> Result<Response<Body>> {
    let method = req.method().as_str().to_uppercase();
    let path = req.uri().path().to_string();
    let query: HashMap<String, String> = req
        .uri()
        .query()
        .map(|q| {
            deno_core::url::form_urlencoded::parse(q.as_bytes())
                .into_owned()
                .collect()
        })
        .unwrap_or_default();

    let (specifier, params, kind) = {
        let table = state.routes.read().await;
        match table.match_path(&path) {
            Some((route, params)) => {
                let spec = deno_core::ModuleSpecifier::from_file_path(&route.file)
                    .map_err(|_| anyhow::anyhow!("bad route path {}", route.file.display()))?;
                (spec.to_string(), params, route.kind)
            }
            None => return Ok(text_response(StatusCode::NOT_FOUND, format!("no route for {path}"))),
        }
    };

    if kind == RouteKind::Page {
        return Ok(text_response(
            StatusCode::NOT_IMPLEMENTED,
            "page routes (React SSR) land in M4; API routes under app/routes/api work today".to_string(),
        ));
    }

    let headers: HashMap<String, String> = req
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let body_bytes = axum::body::to_bytes(req.into_body(), MAX_BODY_BYTES).await?;
    let body = if body_bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(String::from_utf8_lossy(&body_bytes).into_owned())
    };

    let request_json = json!({
        "method": method,
        "path": path,
        "params": params,
        "query": query,
        "headers": headers,
        "body": body,
    })
    .to_string();

    let (reply_tx, reply_rx) = oneshot::channel();
    let msg = WorkerMsg::Route {
        specifier,
        method,
        request_json,
        reply: reply_tx,
    };
    state
        .worker_tx
        .read()
        .await
        .send(msg)
        .await
        .map_err(|_| anyhow::anyhow!("js worker is gone"))?;

    let result = tokio::time::timeout(REQUEST_TIMEOUT, reply_rx)
        .await
        .map_err(|_| anyhow::anyhow!("route handler timed out after {REQUEST_TIMEOUT:?}"))?
        .map_err(|_| anyhow::anyhow!("js worker dropped the request (reloading?)"))?;

    match result {
        Ok(route_resp) => {
            let mut builder = Response::builder().status(route_resp.status);
            for (k, v) in &route_resp.headers {
                builder = builder.header(k, v);
            }
            Ok(builder.body(Body::from(route_resp.body))?)
        }
        // JS error: readable, source-mapped stack in the dev response
        Err(stack) => Ok(text_response(StatusCode::INTERNAL_SERVER_ERROR, stack)),
    }
}

fn text_response(status: StatusCode, body: String) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(Body::from(body))
        .expect("static response")
}
