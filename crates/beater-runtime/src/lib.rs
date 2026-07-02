//! The beater.js host runtime: axum HTTP server, file-based router,
//! deno_core (V8) worker thread, TS/TSX transpiling module loader, hot reload.

mod config;
mod loader;
mod router;
mod server;
mod worker;

pub use config::AppConfig;
pub use router::{Route, RouteKind, RouteTable};

use std::path::Path;

use anyhow::Result;

/// Start the dev server for the app at `app_dir`. Blocks until ctrl-c.
pub fn dev(app_dir: &Path, port_override: Option<u16>) -> Result<()> {
    let config = AppConfig::load(app_dir)?;
    let port = port_override.unwrap_or(config.port);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(server::serve(config, port))
}

/// The embedded V8 version, for `beater doctor`.
pub fn v8_version() -> &'static str {
    deno_core::v8::VERSION_STRING
}
