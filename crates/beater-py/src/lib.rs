//! Embedded CPython (tier 2): interpreter init, runtime venv attach,
//! spawn_blocking tool bridge.
//!
//! pyo3's `auto-initialize` initializes the interpreter with
//! `Py_InitializeEx(0)` — no Python signal handlers — so tokio owns SIGINT.
//! Build-time linking is controlled by `PYO3_PYTHON` (.cargo/config.toml);
//! runtime packages are attached via `site.addsitedir(<venv>/site-packages)`
//! (ARCHITECTURE.md §4). Tools are plain .py files: module-level `TOOL`
//! metadata dict + a `run(input) -> dict` entrypoint, executed fresh per call
//! via runpy so edits are picked up without restarting.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use pyo3::prelude::*;
use tokio::sync::Semaphore;

/// Cap concurrent Python executions: every call holds the GIL on a blocking
/// thread, so unbounded fan-out would only pile up blocked threads.
static PY_PERMITS: Semaphore = Semaphore::const_new(4);

#[derive(Debug, Clone)]
pub struct PythonRuntime {
    pub version: String,
    pub executable: String,
    pub major: u32,
    pub minor: u32,
}

/// Interpreter version + executable, for `beater doctor`.
pub fn python_info() -> Result<String> {
    let runtime = python_runtime()?;
    Ok(format!(
        "{} ({})",
        runtime
            .version
            .split_whitespace()
            .next()
            .unwrap_or(&runtime.version),
        runtime.executable
    ))
}

pub fn python_runtime() -> Result<PythonRuntime> {
    Python::attach(|py| {
        let sys = py.import("sys")?;
        let version: String = sys.getattr("version")?.extract()?;
        let executable: String = sys.getattr("executable")?.extract()?;
        let version_info = sys.getattr("version_info")?;
        let major: u32 = version_info.getattr("major")?.extract()?;
        let minor: u32 = version_info.getattr("minor")?.extract()?;
        Ok(PythonRuntime {
            version,
            executable,
            major,
            minor,
        })
    })
}

pub fn expected_venv_site_packages(venv: &Path) -> Result<PathBuf> {
    let runtime = python_runtime()?;
    Ok(venv
        .join("lib")
        .join(format!("python{}.{}", runtime.major, runtime.minor))
        .join("site-packages"))
}

pub fn check_venv(venv: &Path) -> Result<PathBuf> {
    let runtime = python_runtime()?;
    let site_packages = expected_venv_site_packages(venv)?;
    if !venv.is_dir() {
        bail!(
            "missing venv at {}; create it with `python{}.{} -m venv {}`",
            venv.display(),
            runtime.major,
            runtime.minor,
            venv.display()
        );
    }
    if !site_packages.is_dir() {
        bail!(
            "venv at {} has no {} — the embedded interpreter is python{}.{}; \
             recreate the venv with a matching version (e.g. `python{}.{} -m venv {}`)",
            venv.display(),
            site_packages.display(),
            runtime.major,
            runtime.minor,
            runtime.major,
            runtime.minor,
            venv.display(),
        );
    }
    Ok(site_packages)
}

/// Attach a venv's site-packages to the embedded interpreter.
///
/// This is the *runtime* half of Python setup — the linked libpython is fixed
/// at build time, so the venv must match its minor version. Callers that want
/// stdlib-only tools should skip this when no venv exists.
pub fn attach_venv(venv: &Path) -> Result<()> {
    let site_packages = check_venv(venv)?;
    Python::attach(|py| {
        py.import("site")?
            .call_method1("addsitedir", (site_packages.to_string_lossy().as_ref(),))?;
        tracing::info!("attached venv site-packages: {}", site_packages.display());
        Ok(())
    })
}

/// Read a tool file's `TOOL` metadata: (description, input_schema).
pub fn load_tool_spec(path: &Path) -> Result<(String, serde_json::Value)> {
    Python::attach(|py| {
        let module = run_path(py, path)?;
        let tool = module
            .get_item("TOOL")
            .with_context(|| format!("{} does not define a TOOL dict", path.display()))?;
        let json = py.import("json")?;
        let spec_json: String = json.call_method1("dumps", (tool,))?.extract()?;
        let spec: serde_json::Value = serde_json::from_str(&spec_json)?;
        let description = spec
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or_default()
            .to_string();
        let input_schema = spec
            .get("input_schema")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({"type": "object"}));
        Ok((description, input_schema))
    })
}

/// Execute a tool's `run(input)` with a JSON input, returning JSON output.
/// Runs on the blocking pool behind a semaphore — the GIL never blocks the
/// async runtime.
pub async fn call_tool(path: PathBuf, input_json: String) -> Result<String> {
    let _permit = PY_PERMITS.acquire().await.expect("semaphore never closed");
    tokio::task::spawn_blocking(move || call_tool_blocking(&path, &input_json))
        .await
        .context("python tool task panicked")?
}

fn call_tool_blocking(path: &Path, input_json: &str) -> Result<String> {
    Python::attach(|py| {
        let module = run_path(py, path)?;
        let run = module
            .get_item("run")
            .with_context(|| format!("{} does not define run(input)", path.display()))?;
        let json = py.import("json")?;
        let input = json.call_method1("loads", (input_json,))?;
        let result = run
            .call1((input,))
            .with_context(|| format!("python tool {} raised", path.display()))?;
        let out: String = json.call_method1("dumps", (result,))?.extract()?;
        Ok(out)
    })
}

/// Execute a .py file into a fresh namespace dict (runpy.run_path).
fn run_path<'py>(py: Python<'py>, path: &Path) -> Result<Bound<'py, PyAny>> {
    let runpy = py.import("runpy")?;
    let module = runpy
        .call_method1("run_path", (path.to_string_lossy().as_ref(),))
        .with_context(|| format!("failed to load python tool {}", path.display()))?;
    Ok(module)
}
