//! ESM module loader for the embedded isolate: reads files, transpiles
//! TS/TSX/JSX via deno_ast (SWC) with inline source maps so stack traces
//! point at the original source.

use deno_ast::{
    EmitOptions, JsxAutomaticOptions, JsxRuntime, MediaType, ParseParams, SourceMapOption,
    TranspileOptions,
};
use deno_core::error::ModuleLoaderError;
use deno_core::{
    ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader, ModuleResolveResponse,
    ModuleSource, ModuleSourceCode, ModuleSpecifier, ModuleType, ResolutionKind, resolve_import,
};
use deno_error::JsErrorBox;

pub struct BeaterModuleLoader;

/// Bare specifiers served from vendored, checked-in ESM bundles — the whole
/// "npm resolution" story for the framework's own JS (ARCHITECTURE.md §8).
fn vendor_specifier(specifier: &str) -> Option<&'static str> {
    match specifier {
        "react" => Some("beater:vendor/react"),
        "react/jsx-runtime" | "react/jsx-dev-runtime" => Some("beater:vendor/react-jsx-runtime"),
        "react-dom/server" => Some("beater:vendor/react-dom-server"),
        _ => None,
    }
}

fn vendor_source(specifier: &str) -> Option<&'static str> {
    match specifier {
        "beater:agent" => Some(include_str!("beater_agent.js")),
        "beater:vendor/react" => Some(include_str!("../assets/vendor/react.mjs")),
        "beater:vendor/react-jsx-runtime" => {
            Some(include_str!("../assets/vendor/react-jsx-runtime.mjs"))
        }
        "beater:vendor/react-dom-server" => {
            Some(include_str!("../assets/vendor/react-dom-server.mjs"))
        }
        _ => None,
    }
}

impl ModuleLoader for BeaterModuleLoader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: ResolutionKind,
    ) -> ModuleResolveResponse {
        if let Some(mapped) = vendor_specifier(specifier) {
            return ModuleSpecifier::parse(mapped).map_err(JsErrorBox::from_err);
        }
        resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)
    }

    fn load(
        &self,
        specifier: &ModuleSpecifier,
        _maybe_referrer: Option<&ModuleLoadReferrer>,
        _options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        ModuleLoadResponse::Sync(load_sync(specifier))
    }
}

fn load_sync(specifier: &ModuleSpecifier) -> Result<ModuleSource, ModuleLoaderError> {
    // framework-provided modules under the beater: scheme
    if specifier.scheme() == "beater" {
        let source = vendor_source(specifier.as_str())
            .ok_or_else(|| JsErrorBox::generic(format!("unknown beater module {specifier}")))?;
        return Ok(ModuleSource::new(
            ModuleType::JavaScript,
            ModuleSourceCode::String(deno_core::FastString::from_static(source)),
            specifier,
            None,
        ));
    }
    let path = specifier
        .to_file_path()
        .map_err(|_| JsErrorBox::generic(format!("not a loadable specifier: {specifier}")))?;
    let code = std::fs::read_to_string(&path)
        .map_err(|e| JsErrorBox::generic(format!("failed to read {}: {e}", path.display())))?;

    let media_type = MediaType::from_specifier(specifier);
    let (code, module_type) = match media_type {
        MediaType::JavaScript | MediaType::Mjs | MediaType::Cjs => (code, ModuleType::JavaScript),
        MediaType::Json => (code, ModuleType::Json),
        MediaType::TypeScript
        | MediaType::Mts
        | MediaType::Cts
        | MediaType::Jsx
        | MediaType::Tsx => (
            transpile(specifier, code, media_type)
                .map_err(|e| JsErrorBox::generic(format!("transpile {specifier}: {e:#}")))?,
            ModuleType::JavaScript,
        ),
        other => {
            return Err(JsErrorBox::generic(format!(
                "unsupported module type {other:?} for {specifier}"
            )));
        }
    };

    Ok(ModuleSource::new(
        module_type,
        ModuleSourceCode::String(code.into()),
        specifier,
        None,
    ))
}

fn transpile(
    specifier: &ModuleSpecifier,
    code: String,
    media_type: MediaType,
) -> anyhow::Result<String> {
    let parsed = deno_ast::parse_module(ParseParams {
        specifier: specifier.clone(),
        text: code.into(),
        media_type,
        capture_tokens: false,
        scope_analysis: false,
        maybe_syntax: None,
    })?;
    let transpiled = parsed.transpile(
        &TranspileOptions {
            // React 17+ automatic JSX runtime; resolved from the vendored
            // assets in M4. Harmless for plain TS.
            jsx: Some(JsxRuntime::Automatic(JsxAutomaticOptions {
                development: false,
                import_source: Some("react".to_string()),
            })),
            ..Default::default()
        },
        &Default::default(),
        &EmitOptions {
            source_map: SourceMapOption::Inline,
            ..Default::default()
        },
    )?;
    Ok(transpiled.into_source().text)
}
