/**
 * Runs the inline module script of a generated admin/teacher page against a
 * permissive fake DOM and a fake Supabase client, so tests can assert which
 * auth UI is visible in each lifecycle state without a browser.
 */

export interface FakeUser { id: string; email: string }
export interface FakeSession { expires_at: number; user: FakeUser }
type AuthError = { message: string; code?: string } | null;

export interface FakeAuthBehavior {
	session?: FakeSession | null;
	exchange?: (code: string) => Promise<{ data: unknown; error: AuthError }>;
	getUser?: () => Promise<{ data: { user: FakeUser | null }; error: AuthError }>;
	refresh?: () => Promise<{ data: { session: FakeSession | null }; error: AuthError }>;
	signIn?: () => Promise<{ data: { url: string | null }; error: AuthError }>;
}

export const FUTURE = Math.floor(Date.now() / 1000) + 3600;
export const PAST = Math.floor(Date.now() / 1000) - 3600;

export function fakeAuth(behavior: FakeAuthBehavior = {}) {
	const state = { session: behavior.session ?? null, exchanges: [] as string[], signOuts: 0, signIns: 0 };
	const auth = {
		getSession: async () => ({ data: { session: state.session }, error: null }),
		getUser: behavior.getUser ?? (async () => state.session
			? { data: { user: state.session.user }, error: null }
			: { data: { user: null }, error: { message: "Auth session missing!" } }),
		refreshSession: behavior.refresh ?? (async () => ({ data: { session: state.session }, error: null })),
		exchangeCodeForSession: async (code: string) => {
			state.exchanges.push(code);
			const result = behavior.exchange ? await behavior.exchange(code) : { data: {}, error: null };
			if (!result.error) state.session = { expires_at: FUTURE, user: { id: "u-1", email: "person@example.test" } };
			return result;
		},
		setSession: async () => ({ data: {}, error: null }),
		signInWithOAuth: async () => { state.signIns += 1; return behavior.signIn ? behavior.signIn() : { data: { url: "https://accounts.google.test/authorize" }, error: null }; },
		signOut: async () => { state.signOuts += 1; state.session = null; return { error: null }; },
		onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
	};
	return { auth, state };
}

interface ElementRecord { classes: Set<string>; props: Record<string, unknown>; handlers: Record<string, unknown> }

function permissive(record?: ElementRecord): unknown {
	const target = function () { /* callable stub */ };
	const self: unknown = new Proxy(target, {
		get(_, property) {
			if (property === "then") return undefined;
			if (property === Symbol.iterator) return function* () { /* empty */ };
			if (property === Symbol.toPrimitive) return () => "";
			if (record) {
				if (property === "classList") return {
					add: (...names: string[]) => names.forEach(name => record.classes.add(name)),
					remove: (...names: string[]) => names.forEach(name => record.classes.delete(name)),
					toggle: (name: string, force?: boolean) => { const on = force === undefined ? !record.classes.has(name) : Boolean(force); if (on) record.classes.add(name); else record.classes.delete(name); return on; },
					contains: (name: string) => record.classes.has(name),
				};
				if (typeof property === "string" && property in record.props) return record.props[property];
				if (property === "textContent" || property === "innerHTML" || property === "value" || property === "innerText") return "";
				if (property === "dataset" || property === "style") return {};
				if (property === "options" || property === "children") return [];
			}
			return self;
		},
		set(_, property, value) { if (record && typeof property === "string") record.props[property] = value; return true; },
		apply() { return self; },
	});
	return self;
}

export interface PageRun {
	visible(id: string): boolean;
	text(id: string): string;
	disabled(id: string): boolean;
	href(): string;
	click(id: string): Promise<void>;
	/** Lets pending microtasks and timers run. */
	settle(ms?: number): Promise<void>;
}

export interface RunPageOptions {
	href: string;
	auth: ReturnType<typeof fakeAuth>["auth"];
	/** Row data returned by `db.from(table)…`, keyed by table name. */
	tables?: Record<string, unknown>;
	/** Return values of `db.rpc(name)`. */
	rpc?: Record<string, unknown>;
}

export async function runPage(html: string, options: RunPageOptions): Promise<PageRun> {
	const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
	if (!script) throw new Error("Page has no module script");
	const body = script.replace(/^\s*import\s[^;]*;/gm, "");
	const records = new Map<string, ElementRecord>();
	const elements = new Map<string, unknown>();
	const record = (id: string) => {
		if (!records.has(id)) records.set(id, { classes: new Set(), props: {}, handlers: {} });
		return records.get(id)!;
	};
	// Seed classes from the markup so "hidden" defaults match the real page before any script runs.
	for (const tag of html.matchAll(/<[a-z0-9]+\b[^>]*>/gi)) {
		const id = tag[0].match(/\bid="([^"]+)"/)?.[1];
		const classes = tag[0].match(/\bclass="([^"]*)"/)?.[1];
		if (id && classes) for (const name of classes.split(/\s+/).filter(Boolean)) record(id).classes.add(name);
	}
	const document = {
		getElementById: (id: string) => { if (!elements.has(id)) elements.set(id, permissive(record(id))); return elements.get(id); },
		querySelector: () => permissive(),
		querySelectorAll: () => [],
		createElement: () => permissive({ classes: new Set(), props: {}, handlers: {} }),
		addEventListener() { /* no-op */ },
		body: permissive(),
		title: "",
	};
	const current = new URL(options.href);
	const location = {
		get href() { return current.href; },
		get origin() { return current.origin; },
		get pathname() { return current.pathname; },
		get search() { return current.search; },
		get hash() { return current.hash; },
		reload() { /* no-op */ },
	};
	const history = { replaceState(_state: unknown, _title: string, url: string) { current.href = new URL(url, current.href).href; } };
	const query = (result: unknown): unknown => new Proxy(function () { /* chain */ }, {
		get(_, property) {
			if (property === "then") return (resolve: (value: unknown) => unknown) => resolve(result);
			return (..._args: unknown[]) => query(result);
		},
	});
	const db = {
		auth: options.auth,
		from: (table: string) => query({ data: options.tables?.[table] ?? [], error: null, count: 0 }),
		rpc: async (name: string) => ({ data: options.rpc?.[name] ?? null, error: null }),
	};
	const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
	const names = ["createClient", "document", "location", "history", "window", "fetch", "console", "localStorage", "sessionStorage", "navigator", "requestAnimationFrame", "matchMedia", "confirm", "MutationObserver", "HTMLElement", "Node", "Event"];
	const run = new AsyncFunction(...names, body);
	const storage = { getItem: () => null, setItem() { /* no-op */ }, removeItem() { /* no-op */ } };
	const windowStub = { addEventListener() { /* no-op */ }, location, history, document, matchMedia: () => ({ matches: false, addEventListener() { /* no-op */ } }) };
	let failure: unknown;
	void run(() => db, document, location, history, windowStub, async () => ({ ok: true, json: async () => ({}) }), { log() { /* quiet */ }, error() { /* quiet */ }, warn() { /* quiet */ } }, storage, storage, { userAgent: "test" }, (callback: () => void) => callback(), windowStub.matchMedia, () => true, class { observe() { /* no-op */ } disconnect() { /* no-op */ } }, class { }, class { }, class { })
		.catch(error => { failure = error; });
	const settle = async (ms = 10) => {
		await new Promise<void>(resolve => setTimeout(resolve, ms));
		if (failure) throw failure;
	};
	await settle();
	return {
		visible: id => !record(id).classes.has("hidden"),
		text: id => String(record(id).props.textContent ?? ""),
		disabled: id => Boolean(record(id).props.disabled),
		href: () => current.href,
		click: async id => { const handler = record(id).props.onclick; if (typeof handler === "function") await (handler as () => unknown)(); await settle(); },
		settle,
	};
}
