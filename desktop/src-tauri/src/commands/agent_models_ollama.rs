//! Local-model support via Ollama.
//!
//! Ollama speaks the OpenAI API, so it reuses that discovery path wholesale
//! rather than getting one of its own. It differs in exactly two ways, both
//! handled here: the endpoint defaults to localhost instead of api.openai.com,
//! and there is no API key to ask the user for.

use std::collections::BTreeMap;

/// Provider id, as stored on the agent record and shown in the UI.
pub const OLLAMA_PROVIDER_ID: &str = "ollama";

/// Default OpenAI-compatible endpoint exposed by `ollama serve`.
pub const OLLAMA_DEFAULT_BASE_URL: &str = "http://localhost:11434/v1";

/// Ollama ignores the key, but the OpenAI transport requires a non-empty one.
pub const OLLAMA_API_KEY_PLACEHOLDER: &str = "ollama";

/// True when `provider` names a local Ollama server.
pub fn is_ollama_provider(provider: Option<&str>) -> bool {
    provider
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
        == Some(OLLAMA_PROVIDER_ID)
}

/// Fill in the OpenAI-compatible env the Ollama provider implies.
///
/// Only values the user has not already set are added, so an explicit base URL
/// — a remote Ollama, or a non-default port — still wins. Supplying both keys
/// here is what lets the existing OpenAI-compatible path work untouched, for
/// both model discovery and the spawned agent.
pub fn with_local_defaults(
    mut env: BTreeMap<String, String>,
    provider: Option<&str>,
) -> BTreeMap<String, String> {
    if !is_ollama_provider(provider) {
        return env;
    }
    // Overwrite, don't fill in: the record's provider name ("ollama") is
    // written here by the generic provider->env mapping, and buzz-agent only
    // understands its transport names. Ollama's transport is plain OpenAI.
    env.insert("BUZZ_AGENT_PROVIDER".to_string(), "openai".to_string());
    env.entry("OPENAI_COMPAT_BASE_URL".to_string())
        .or_insert_with(|| OLLAMA_DEFAULT_BASE_URL.to_string());
    env.entry("OPENAI_COMPAT_API_KEY".to_string())
        .or_insert_with(|| OLLAMA_API_KEY_PLACEHOLDER.to_string());
    env.entry("OPENAI_COMPAT_API".to_string())
        .or_insert_with(|| "chat".to_string());
    // The chosen model arrives as BUZZ_AGENT_MODEL; the OpenAI transport reads
    // OPENAI_COMPAT_MODEL. Mirror it across so the agent starts on the right one.
    if let Some(model) = env.get("BUZZ_AGENT_MODEL").cloned() {
        env.entry("OPENAI_COMPAT_MODEL".to_string())
            .or_insert(model);
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_defaults_for_ollama_only() {
        let empty = BTreeMap::new();
        let filled = with_local_defaults(empty.clone(), Some("ollama"));
        assert_eq!(
            filled.get("OPENAI_COMPAT_BASE_URL").map(String::as_str),
            Some(OLLAMA_DEFAULT_BASE_URL)
        );
        assert!(filled.contains_key("OPENAI_COMPAT_API_KEY"));
        assert_eq!(
            filled.get("BUZZ_AGENT_PROVIDER").map(String::as_str),
            Some("openai"),
            "buzz-agent does not understand the provider name 'ollama'"
        );
        assert!(with_local_defaults(empty, Some("anthropic")).is_empty());
    }

    #[test]
    fn overwrites_a_preset_ollama_provider_name() {
        let mut env = BTreeMap::new();
        env.insert("BUZZ_AGENT_PROVIDER".to_string(), "ollama".to_string());
        env.insert("BUZZ_AGENT_MODEL".to_string(), "gemma4:12b".to_string());
        let filled = with_local_defaults(env, Some("ollama"));
        assert_eq!(
            filled.get("BUZZ_AGENT_PROVIDER").map(String::as_str),
            Some("openai")
        );
        assert_eq!(
            filled.get("OPENAI_COMPAT_MODEL").map(String::as_str),
            Some("gemma4:12b")
        );
    }

    #[test]
    fn user_supplied_base_url_wins() {
        let mut env = BTreeMap::new();
        env.insert(
            "OPENAI_COMPAT_BASE_URL".to_string(),
            "http://box.local:11434/v1".to_string(),
        );
        let filled = with_local_defaults(env, Some("ollama"));
        assert_eq!(
            filled.get("OPENAI_COMPAT_BASE_URL").map(String::as_str),
            Some("http://box.local:11434/v1")
        );
    }
}
