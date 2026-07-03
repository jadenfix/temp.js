//! The Agent Access Layer's crawl half (ARCHITECTURE.md §6b): robots.txt,
//! sitemap.xml, llms.txt, and the .well-known manifest — all generated from
//! the route table and agent registry, never hand-maintained.

use serde_json::json;

use crate::worker::RouteMeta;

pub fn robots_txt(base_url: &str) -> String {
    format!(
        "User-agent: *\nAllow: /\n\nSitemap: {base_url}/sitemap.xml\n# agent-readable map: {base_url}/llms.txt\n# manifest: {base_url}/.well-known/beater.json\n"
    )
}

/// Crawlable routes (per their `agent` metadata) with lastmod from file mtime.
pub fn sitemap_xml(
    base_url: &str,
    routes: &[(String, std::path::PathBuf, Option<RouteMeta>)],
) -> String {
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n",
    );
    for (pattern, file, meta) in routes {
        if matches!(meta, Some(m) if !m.crawl) {
            continue;
        }
        let lastmod = std::fs::metadata(file)
            .and_then(|m| m.modified())
            .ok()
            .map(|t| {
                chrono::DateTime::<chrono::Utc>::from(t)
                    .format("%Y-%m-%d")
                    .to_string()
            });
        out.push_str("  <url>\n");
        out.push_str(&format!(
            "    <loc>{}</loc>\n",
            escape_xml_text(&format!("{base_url}{pattern}"))
        ));
        if let Some(lastmod) = lastmod {
            out.push_str(&format!("    <lastmod>{lastmod}</lastmod>\n"));
        }
        out.push_str("  </url>\n");
    }
    out.push_str("</urlset>\n");
    out
}

/// llms.txt: a curated, agent-readable map of the site. Route entries are
/// enriched by each module's optional `export const agent = {...}` metadata.
pub fn llms_txt(
    app_name: &str,
    base_url: &str,
    routes: &[(String, Option<RouteMeta>)],
    agents: &[String],
    mcp_access: &crate::mcp::AccessConfig,
) -> String {
    let mut out = format!("# {app_name}\n\n> Served by beater.js — agent-first web framework.\n\n");
    out.push_str("## Routes\n\n");
    for (pattern, meta) in routes {
        match meta {
            Some(m) if !m.crawl => continue,
            Some(m) => {
                let title = m.title.clone().unwrap_or_else(|| pattern.clone());
                match &m.description {
                    Some(d) => out.push_str(&format!("- [{title}]({base_url}{pattern}): {d}\n")),
                    None => out.push_str(&format!("- [{title}]({base_url}{pattern})\n")),
                }
            }
            None => out.push_str(&format!("- [{pattern}]({base_url}{pattern})\n")),
        }
    }
    if !agents.is_empty() {
        out.push_str("\n## Agents\n\n");
        for agent in agents {
            out.push_str(&format!("- {agent}\n"));
        }
    }
    let auth_note = if mcp_access.auth_required() {
        "requires Authorization: Bearer <token>"
    } else {
        "no bearer token configured"
    };
    out.push_str(&format!(
        "\n## For AI agents\n\n- MCP endpoint (tools): {base_url}/mcp (Streamable HTTP, spec {}; {auth_note})\n- Manifest: {base_url}/.well-known/beater.json\n",
        crate::mcp::PROTOCOL_VERSION,
    ));
    out
}

pub fn well_known(
    app_name: &str,
    base_url: &str,
    agents: &[String],
    mcp_access: &crate::mcp::AccessConfig,
) -> serde_json::Value {
    let auth = if mcp_access.auth_required() {
        json!({"required": true, "schemes": ["bearer"]})
    } else {
        json!({"required": false, "schemes": []})
    };
    json!({
        "name": app_name,
        "framework": {"name": "beater.js", "version": env!("CARGO_PKG_VERSION")},
        "mcp": {
            "endpoint": format!("{base_url}/mcp"),
            "transport": "streamable-http",
            "protocolVersion": crate::mcp::PROTOCOL_VERSION,
            "auth": auth,
            "originPolicy": {
                "noOrigin": "allowed",
                "loopbackOrigins": true,
            },
        },
        "sitemap": format!("{base_url}/sitemap.xml"),
        "llms": format!("{base_url}/llms.txt"),
        "agents": agents,
    })
}

fn escape_xml_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sitemap_xml_escapes_route_locations() {
        let xml = sitemap_xml(
            "https://example.test/root?x=1&y=2",
            &[(
                "/docs/<private>&notes".to_string(),
                std::path::PathBuf::from("missing-route.tsx"),
                None,
            )],
        );

        assert!(
            xml.contains(
                "<loc>https://example.test/root?x=1&amp;y=2/docs/&lt;private&gt;&amp;notes</loc>"
            ),
            "{xml}"
        );
    }

    #[test]
    fn well_known_does_not_disclose_trusted_origins() {
        let manifest = well_known(
            "hello",
            "https://hello.example.test",
            &[],
            &crate::mcp::AccessConfig::new(
                Some("test-secret".to_string()),
                vec!["https://ops.example.test".to_string()],
            ),
        );

        assert_eq!(manifest["mcp"]["originPolicy"]["noOrigin"], "allowed");
        assert_eq!(manifest["mcp"]["originPolicy"]["loopbackOrigins"], true);
        assert!(
            manifest["mcp"]["originPolicy"]
                .as_object()
                .is_some_and(|policy| !policy.contains_key("trustedOrigins"))
        );
        assert!(!manifest.to_string().contains("https://ops.example.test"));
    }
}
