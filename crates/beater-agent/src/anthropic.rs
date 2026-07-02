//! Minimal Messages API client over raw reqwest (there is no official Rust
//! SDK). Non-streaming: each request is exactly one journaled step.

use anyhow::{Context, Result, bail};
use serde_json::Value;

const API_URL: &str = "https://api.anthropic.com/v1/messages";

pub struct Anthropic {
    http: reqwest::Client,
    api_key: String,
}

impl Anthropic {
    pub fn from_env() -> Result<Self> {
        let api_key = std::env::var("ANTHROPIC_API_KEY")
            .context("ANTHROPIC_API_KEY is not set — required for `beater agent run`")?;
        Ok(Self {
            http: reqwest::Client::new(),
            api_key,
        })
    }

    pub async fn create_message(&self, body: &Value) -> Result<Value> {
        let mut delay = std::time::Duration::from_secs(2);
        for attempt in 1..=3 {
            let resp = self
                .http
                .post(API_URL)
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(body)
                .send()
                .await?;
            let status = resp.status();
            let text = resp.text().await?;
            // 429 / 500 / 529 are retryable per the API error reference
            if status.as_u16() == 429 || status.as_u16() >= 500 {
                if attempt < 3 {
                    tracing::warn!("anthropic {status}, retrying in {delay:?}");
                    tokio::time::sleep(delay).await;
                    delay *= 4;
                    continue;
                }
            }
            if !status.is_success() {
                bail!("anthropic api error {status}: {text}");
            }
            return serde_json::from_str(&text).context("anthropic response was not JSON");
        }
        unreachable!("retry loop returns or bails")
    }
}
