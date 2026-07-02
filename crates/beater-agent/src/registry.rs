//! One registry, three tool tiers: Python files (embedded CPython), Rust
//! built-ins, and (later) inline TS + sandboxed wasm. Every tool declares
//! `idempotent` — the resume-safety contract (ARCHITECTURE.md §5).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
pub struct AgentConfig {
    pub name: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub tools: Vec<ToolDecl>,
}

fn default_model() -> String {
    "claude-opus-4-8".to_string()
}

#[derive(Debug, Deserialize)]
pub struct ToolDecl {
    pub kind: String, // "python" | "rust"
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub idempotent: bool,
}

pub enum ToolImpl {
    Python { path: PathBuf },
    RustBuiltin,
}

pub struct ToolEntry {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub idempotent: bool,
    pub imp: ToolImpl,
}

pub struct ToolRegistry {
    tools: Vec<ToolEntry>,
}

impl ToolRegistry {
    /// Build from an agent's tool declarations. Python tool metadata comes
    /// from each file's module-level TOOL dict.
    pub fn build(agent_dir: &Path, decls: &[ToolDecl]) -> Result<Self> {
        let mut tools = Vec::new();
        for decl in decls {
            match decl.kind.as_str() {
                "python" => {
                    let rel = decl
                        .path
                        .as_deref()
                        .with_context(|| format!("python tool {} has no path", decl.name))?;
                    let path = agent_dir.join(rel.trim_start_matches("./"));
                    let (description, input_schema) = beater_py::load_tool_spec(&path)
                        .with_context(|| format!("loading python tool {}", decl.name))?;
                    tools.push(ToolEntry {
                        name: decl.name.clone(),
                        description,
                        input_schema,
                        idempotent: decl.idempotent,
                        imp: ToolImpl::Python { path },
                    });
                }
                "rust" => {
                    let entry = rust_builtin(&decl.name)
                        .with_context(|| format!("unknown rust builtin tool {}", decl.name))?;
                    tools.push(entry);
                }
                other => bail!("unknown tool kind {other:?} for tool {}", decl.name),
            }
        }
        Ok(Self { tools })
    }

    pub fn get(&self, name: &str) -> Option<&ToolEntry> {
        self.tools.iter().find(|t| t.name == name)
    }

    /// Tool definitions in Messages API shape.
    pub fn api_tools(&self) -> Value {
        Value::Array(
            self.tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema,
                    })
                })
                .collect(),
        )
    }

    /// Execute a tool; returns the result serialized as a JSON string
    /// (the tool_result content).
    pub async fn execute(&self, name: &str, input: &Value) -> Result<String> {
        let tool = self.get(name).with_context(|| format!("no tool named {name}"))?;
        match &tool.imp {
            ToolImpl::Python { path } => {
                beater_py::call_tool(path.clone(), input.to_string()).await
            }
            ToolImpl::RustBuiltin => execute_builtin(name, input),
        }
    }
}

fn rust_builtin(name: &str) -> Option<ToolEntry> {
    match name {
        "get_time" => Some(ToolEntry {
            name: name.to_string(),
            description: "Get the current date and time (UTC).".to_string(),
            input_schema: json!({"type": "object", "properties": {}}),
            idempotent: true, // no side effects; safe to re-run on resume
            imp: ToolImpl::RustBuiltin,
        }),
        _ => None,
    }
}

fn execute_builtin(name: &str, _input: &Value) -> Result<String> {
    match name {
        "get_time" => {
            let now = chrono::Utc::now();
            Ok(json!({"iso": now.to_rfc3339(), "unix": now.timestamp()}).to_string())
        }
        _ => bail!("no rust builtin {name}"),
    }
}
