use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteKind {
    /// `.ts`/`.js` — exports HTTP method handlers (GET, POST, ...).
    Api,
    /// `.tsx`/`.jsx` — exports a default React component (SSR, M4).
    Page,
}

#[derive(Debug, Clone)]
pub enum Segment {
    Static(String),
    /// `[id]` in the filename.
    Param(String),
}

#[derive(Debug, Clone)]
pub struct Route {
    pub segments: Vec<Segment>,
    pub file: PathBuf,
    pub kind: RouteKind,
    /// Display form, e.g. `/users/[id]`.
    pub pattern: String,
}

#[derive(Debug, Default)]
pub struct RouteTable {
    routes: Vec<Route>,
}

impl RouteTable {
    /// Scan `<app_dir>/app/routes/**` into a route table.
    ///
    /// `index.*` maps to the directory itself; `[name]` segments are dynamic.
    pub fn scan(app_dir: &Path) -> Result<Self> {
        let routes_dir = app_dir.join("app").join("routes");
        let mut routes = Vec::new();
        if routes_dir.is_dir() {
            for entry in walkdir::WalkDir::new(&routes_dir)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                let path = entry.path();
                let kind = match path.extension().and_then(|e| e.to_str()) {
                    Some("ts") | Some("js") | Some("mjs") => RouteKind::Api,
                    Some("tsx") | Some("jsx") => RouteKind::Page,
                    _ => continue,
                };
                let rel = path.strip_prefix(&routes_dir)?.with_extension("");
                let mut segments = Vec::new();
                let mut pattern = String::new();
                let components: Vec<_> = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                for (i, comp) in components.iter().enumerate() {
                    // trailing `index` maps to the parent directory
                    if i == components.len() - 1 && comp == "index" {
                        break;
                    }
                    pattern.push('/');
                    pattern.push_str(comp);
                    if let Some(name) = comp.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                        segments.push(Segment::Param(name.to_string()));
                    } else {
                        segments.push(Segment::Static(comp.clone()));
                    }
                }
                if pattern.is_empty() {
                    pattern.push('/');
                }
                routes.push(Route {
                    segments,
                    file: path.to_path_buf(),
                    kind,
                    pattern,
                });
            }
        }
        // static segments win over params at the same depth
        routes.sort_by_key(|r| {
            r.segments
                .iter()
                .filter(|s| matches!(s, Segment::Param(_)))
                .count()
        });
        Ok(Self { routes })
    }

    pub fn is_empty(&self) -> bool {
        self.routes.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Route> {
        self.routes.iter()
    }

    /// Match a URL path, returning the route and extracted params.
    pub fn match_path(&self, path: &str) -> Option<(&Route, HashMap<String, String>)> {
        let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
        'route: for route in &self.routes {
            if route.segments.len() != parts.len() {
                continue;
            }
            let mut params = HashMap::new();
            for (seg, part) in route.segments.iter().zip(&parts) {
                match seg {
                    Segment::Static(s) if s == part => {}
                    Segment::Static(_) => continue 'route,
                    Segment::Param(name) => {
                        params.insert(name.clone(), (*part).to_string());
                    }
                }
            }
            return Some((route, params));
        }
        None
    }
}
