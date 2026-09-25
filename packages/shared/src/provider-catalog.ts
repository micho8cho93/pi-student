/** Provider IDs match the Pi model runtime; an approval never carries a credential. */
export const providerCatalog = [
	{ id: "openai", name: "OpenAI", connection: "API key" },
	{ id: "openai-codex", name: "Codex", connection: "ChatGPT sign in" },
	{ id: "anthropic", name: "Anthropic (Claude)", connection: "API key" },
	{ id: "google", name: "Google (Gemini)", connection: "API key" },
	{ id: "deepseek", name: "DeepSeek", connection: "API key" },
	{ id: "kimi-coding", name: "Kimi Coding", connection: "API key" },
	{ id: "moonshotai", name: "Moonshot AI", connection: "API key" },
	{ id: "openrouter", name: "OpenRouter", connection: "API key" },
	{ id: "xai", name: "xAI", connection: "API key" },
	{ id: "mistral", name: "Mistral", connection: "API key" },
	{ id: "groq", name: "Groq", connection: "API key" },
	{ id: "ollama", name: "Ollama (local)", connection: "Local server" },
] as const;
