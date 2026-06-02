import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import type { ParseResult, ParserPlugin } from "@babel/parser";
import { parse as parseBabel } from "@babel/parser";
import {
	getDbBusyTimeoutMs,
	getLegacyPiExtensionCacheDbPath,
	isCompiledBinary,
	logger,
	stripWindowsExtendedLengthPathPrefix,
} from "@oh-my-pi/pi-utils";
import { registerPluginCacheInvalidator } from "../../discovery/helpers";

const IS_COMPILED_BINARY = isCompiledBinary();

// === Bundled host modules (issue #3423) ===
//
// Bun 1.3.14 stopped exposing `--compile` extras through any filesystem-style
// API: `fs.existsSync`, `Bun.file().exists()`, `Bun.resolveSync`, and even
// `import("/$bunfs/...")` / `import("file:///$bunfs/...")` all fail for the
// embedded entries. Bun.plugin `onResolve` also no longer fires for transitive
// imports inside runtime-loaded extensions.
//
// Compiled builds retain lazy loaders for host packages and serve requested
// surfaces through `omp-legacy-pi-bundled:<key>` synthetic modules.
// `scripts/legacy-pi-virtual-module.ts` derives literal dynamic-import edges
// from current package exports inside a Bun build plugin: no generated source
// or duplicate key list exists on disk. Deferring each host module evaluation
// avoids cycles with an extension-loading command that is itself in the
// retained package graph.
const BUNDLED_VIRTUAL_SCHEME = "omp-legacy-pi-bundled:";
const BUNDLED_VIRTUAL_NAMESPACE = "omp-legacy-pi-bundled";
const BUNDLED_MODULES_GLOBAL = "__ompLegacyPiBundledModules";
const TYPEBOX_BUNDLED_MODULE_KEY = "typebox";

type BundledModule = Readonly<Record<string, unknown>>;
type BundledModules = Readonly<Record<string, BundledModule>>;
type BundledModuleLoaders = Readonly<Record<string, () => Promise<BundledModule>>>;

interface LegacyPiResolveResult {
	path: string;
	namespace?: string;
}

interface BundledVirtualResolveResult {
	path: string;
	namespace: typeof BUNDLED_VIRTUAL_NAMESPACE;
}

interface ExtensionSpecifierReference {
	readonly kind: "import" | "require";
	readonly specifier: string;
	readonly start: number;
	readonly end: number;
}

function parseExtensionSource(source: string, importerPath: string): ParseResult {
	const extension = path.extname(importerPath).toLowerCase();
	const plugins: ParserPlugin[] = ["decorators-legacy", "explicitResourceManagement"];
	if (extension === ".ts" || extension === ".mts" || extension === ".cts" || extension === ".tsx") {
		plugins.push("typescript");
	}
	if (extension === ".jsx" || extension === ".tsx") {
		plugins.push("jsx");
	}

	try {
		return parseBabel(source, {
			sourceType: "unambiguous",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
			allowNewTargetOutsideFunction: true,
			allowSuperOutsideMethod: true,
			allowUndeclaredExports: true,
			errorRecovery: true,
			plugins,
		});
	} catch (error) {
		throw new Error(
			`Failed to parse extension source for dependency rewriting: ${importerPath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

const REQUIRE_BINDING = 1 << 0;
const OBJECT_BINDING = 1 << 1;
const EXPORTS_BINDING = 1 << 2;
const MODULE_BINDING = 1 << 3;

interface StructuralAstNode {
	readonly type: string;
	readonly [key: string]: unknown;
}

interface BindingScope {
	readonly parent: BindingScope | null;
	readonly ownsVarBindings: boolean;
	bindings: number;
}

interface ScopedAstNode {
	readonly node: StructuralAstNode;
	readonly scope: BindingScope;
	readonly order: number;
}

interface ScopeWalkItem {
	readonly node: StructuralAstNode;
	readonly scope: BindingScope | null;
	readonly parent: StructuralAstNode | null;
	readonly parentKey: string | null;
}

function asAstNode(value: unknown): StructuralAstNode | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as { readonly type?: unknown };
	return typeof candidate.type === "string" ? (candidate as StructuralAstNode) : null;
}

function nodeArray(node: StructuralAstNode, key: string): readonly unknown[] | null {
	const value = node[key];
	return Array.isArray(value) ? value : null;
}

function nodeArgument(node: StructuralAstNode | null, index: number): StructuralAstNode | null {
	if (!node) return null;
	const values = nodeArray(node, "arguments");
	return values ? asAstNode(values[index]) : null;
}

function isIdentifier(node: StructuralAstNode | null, name: string): boolean {
	return node?.type === "Identifier" && node.name === name;
}

function trackedBinding(name: unknown): number {
	switch (name) {
		case "require":
			return REQUIRE_BINDING;
		case "Object":
			return OBJECT_BINDING;
		case "exports":
			return EXPORTS_BINDING;
		case "module":
			return MODULE_BINDING;
		default:
			return 0;
	}
}

function addPatternBindings(scope: BindingScope, pattern: unknown): void {
	const stack: unknown[] = [pattern];
	while (stack.length > 0) {
		const node = asAstNode(stack.pop());
		if (!node) continue;
		switch (node.type) {
			case "Identifier":
				scope.bindings |= trackedBinding(node.name);
				break;
			case "AssignmentPattern":
				stack.push(node.left);
				break;
			case "RestElement":
				stack.push(node.argument);
				break;
			case "ArrayPattern": {
				const elements = nodeArray(node, "elements");
				if (elements) stack.push(...elements);
				break;
			}
			case "ObjectPattern": {
				const properties = nodeArray(node, "properties");
				if (!properties) break;
				for (const value of properties) {
					const property = asAstNode(value);
					if (!property) continue;
					stack.push(property.type === "RestElement" ? property.argument : property.value);
				}
				break;
			}
			case "TSParameterProperty":
				stack.push(node.parameter);
				break;
		}
	}
}

function isFunctionScopeNode(node: StructuralAstNode): boolean {
	switch (node.type) {
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "ArrowFunctionExpression":
		case "ObjectMethod":
		case "ClassMethod":
		case "ClassPrivateMethod":
		case "TSDeclareFunction":
		case "TSDeclareMethod":
		case "DeclareFunction":
			return true;
		default:
			return false;
	}
}

function isFunctionDeclarationNode(node: StructuralAstNode): boolean {
	return node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction" || node.type === "DeclareFunction";
}

function isClassScopeNode(node: StructuralAstNode): boolean {
	return node.type === "ClassDeclaration" || node.type === "ClassExpression";
}

function scopeKind(node: StructuralAstNode, parent: StructuralAstNode | null, parentKey: string | null): 0 | 1 | 2 {
	if (
		node.type === "Program" ||
		isFunctionScopeNode(node) ||
		node.type === "StaticBlock" ||
		node.type === "TSModuleBlock"
	) {
		return 2;
	}
	if (
		isClassScopeNode(node) ||
		node.type === "CatchClause" ||
		node.type === "ForStatement" ||
		node.type === "ForInStatement" ||
		node.type === "ForOfStatement" ||
		node.type === "SwitchStatement"
	) {
		return 1;
	}
	if (node.type === "BlockStatement" && !(parent && isFunctionScopeNode(parent) && parentKey === "body")) {
		return 1;
	}
	return 0;
}

function nearestVarScope(scope: BindingScope): BindingScope {
	let current = scope;
	while (!current.ownsVarBindings && current.parent) current = current.parent;
	return current;
}

function registerOuterDeclaration(node: StructuralAstNode, scope: BindingScope | null): void {
	if (!scope) return;
	if (
		(isFunctionDeclarationNode(node) && node.type !== "TSDeclareFunction" && node.type !== "DeclareFunction") ||
		(node.type === "ClassDeclaration" && node.declare !== true)
	) {
		addPatternBindings(scope, node.id);
	}
}

function registerScopeBindings(node: StructuralAstNode, scope: BindingScope): void {
	if (isFunctionScopeNode(node)) {
		addPatternBindings(scope, node.id);
		const parameters = nodeArray(node, "params");
		if (parameters) {
			for (const parameter of parameters) addPatternBindings(scope, parameter);
		}
	}
	if (isClassScopeNode(node)) addPatternBindings(scope, node.id);
	if (node.type === "CatchClause") addPatternBindings(scope, node.param);

	if (node.type === "ImportDeclaration") {
		const specifiers = nodeArray(node, "specifiers");
		if (specifiers) {
			for (const value of specifiers) {
				const specifier = asAstNode(value);
				if (specifier) addPatternBindings(scope, specifier.local);
			}
		}
	} else if (node.type === "TSImportEqualsDeclaration") {
		addPatternBindings(scope, node.id);
	} else if (node.type === "VariableDeclaration") {
		const target = node.kind === "var" ? nearestVarScope(scope) : scope;
		const declarations = nodeArray(node, "declarations");
		if (declarations) {
			for (const value of declarations) {
				const declaration = asAstNode(value);
				if (declaration) addPatternBindings(target, declaration.id);
			}
		}
	}
}

function isAstMetadataKey(key: string): boolean {
	switch (key) {
		case "loc":
		case "extra":
		case "range":
		case "comments":
		case "tokens":
		case "errors":
		case "leadingComments":
		case "trailingComments":
		case "innerComments":
		case "parent":
		case "parentPath":
		case "scope":
		case "hub":
			return true;
		default:
			return false;
	}
}

function scopeForChild(
	node: StructuralAstNode,
	key: string,
	outerScope: BindingScope | null,
	nodeScope: BindingScope,
): BindingScope {
	if (node.type === "SwitchStatement" && key === "discriminant") {
		return outerScope ?? nodeScope;
	}
	if (isFunctionScopeNode(node) && (key === "key" || key === "decorators")) {
		return outerScope ?? nodeScope;
	}
	if (isClassScopeNode(node) && key === "decorators") {
		return outerScope ?? nodeScope;
	}
	return nodeScope;
}

/**
 * Builds only the lexical information needed by legacy extension rewriting.
 * Scope frames are fully populated before selected nodes are returned, so
 * hoisted and TDZ bindings behave independently of textual declaration order.
 */
function collectScopedAstNodes(root: unknown, select: (node: StructuralAstNode) => boolean): ScopedAstNode[] {
	const rootNode = asAstNode(root);
	if (!rootNode) return [];

	const selected: ScopedAstNode[] = [];
	const stack: ScopeWalkItem[] = [{ node: rootNode, scope: null, parent: null, parentKey: null }];
	const seen = new WeakSet<object>();
	let order = 0;
	while (stack.length > 0) {
		const item = stack.pop();
		if (!item || seen.has(item.node)) continue;
		seen.add(item.node);

		registerOuterDeclaration(item.node, item.scope);
		const kind = scopeKind(item.node, item.parent, item.parentKey);
		const activeScope: BindingScope | null =
			kind === 0
				? item.scope
				: {
						parent: item.scope,
						ownsVarBindings: kind === 2,
						bindings: 0,
					};
		if (activeScope) {
			registerScopeBindings(item.node, activeScope);
			if (select(item.node)) selected.push({ node: item.node, scope: activeScope, order });
		}
		order++;

		for (const key in item.node) {
			if (isAstMetadataKey(key)) continue;
			const childScope = activeScope ? scopeForChild(item.node, key, item.scope, activeScope) : null;
			const value = item.node[key];
			if (Array.isArray(value)) {
				for (const element of value) {
					const child = asAstNode(element);
					if (child) stack.push({ node: child, scope: childScope, parent: item.node, parentKey: key });
				}
			} else {
				const child = asAstNode(value);
				if (child) stack.push({ node: child, scope: childScope, parent: item.node, parentKey: key });
			}
		}
	}

	selected.sort((left, right) => {
		const leftStart = typeof left.node.start === "number" ? left.node.start : Number.MAX_SAFE_INTEGER;
		const rightStart = typeof right.node.start === "number" ? right.node.start : Number.MAX_SAFE_INTEGER;
		return leftStart - rightStart || left.order - right.order;
	});
	return selected;
}

function scopeHasBinding(scope: BindingScope, binding: number): boolean {
	let current: BindingScope | null = scope;
	while (current) {
		if ((current.bindings & binding) !== 0) return true;
		current = current.parent;
	}
	return false;
}

function isSpecifierReferenceNode(node: StructuralAstNode): boolean {
	switch (node.type) {
		case "ImportDeclaration":
		case "ExportNamedDeclaration":
		case "ExportAllDeclaration":
		case "ImportExpression":
		case "TSImportEqualsDeclaration":
		case "CallExpression":
			return true;
		default:
			return false;
	}
}

function isUncomputedMember(node: StructuralAstNode | null, objectName: string, propertyName: string): boolean {
	if (node?.type !== "MemberExpression" || node.computed === true) return false;
	return isIdentifier(asAstNode(node.object), objectName) && isIdentifier(asAstNode(node.property), propertyName);
}

function isUnshadowedExportsTarget(node: StructuralAstNode | null, scope: BindingScope): boolean {
	return (
		(isIdentifier(node, "exports") && !scopeHasBinding(scope, EXPORTS_BINDING)) ||
		(isUncomputedMember(node, "module", "exports") && !scopeHasBinding(scope, MODULE_BINDING))
	);
}

function isGlobalRequireCall(node: StructuralAstNode | null, scope: BindingScope): boolean {
	return (
		node?.type === "CallExpression" &&
		isIdentifier(asAstNode(node.callee), "require") &&
		!scopeHasBinding(scope, REQUIRE_BINDING)
	);
}

/**
 * Whether `node` is a `createRequire(...)` factory call imported from
 * `node:module` (or its `module` alias).
 */
function isCreateRequireInvocation(
	node: StructuralAstNode | null,
	createRequireBindings: ReadonlySet<string>,
	moduleNamespaceBindings: ReadonlySet<string>,
): boolean {
	if (node?.type !== "CallExpression") return false;
	const callee = asAstNode(node.callee);
	if (callee?.type === "Identifier" && typeof callee.name === "string") {
		return createRequireBindings.has(callee.name);
	}
	if (callee?.type !== "MemberExpression" || staticMemberPropertyName(callee) !== "createRequire") return false;
	const object = asAstNode(callee.object);
	return object?.type === "Identifier" && typeof object.name === "string" && moduleNamespaceBindings.has(object.name);
}

function staticMemberPropertyName(node: StructuralAstNode): string | null {
	const property = asAstNode(node.property);
	if (node.computed !== true && property?.type === "Identifier" && typeof property.name === "string") {
		return property.name;
	}
	if (node.computed === true && property?.type === "StringLiteral" && typeof property.value === "string") {
		return property.value;
	}
	return null;
}

function staticObjectPropertyName(node: StructuralAstNode): string | null {
	if (node.computed === true) return null;
	const key = asAstNode(node.key);
	if (key?.type === "Identifier" && typeof key.name === "string") return key.name;
	return key?.type === "StringLiteral" && typeof key.value === "string" ? key.value : null;
}

function collectExtensionSpecifierReferences(
	source: string,
	importerPath: string,
	ast: ParseResult = parseExtensionSource(source, importerPath),
): ExtensionSpecifierReference[] {
	const references: ExtensionSpecifierReference[] = [];
	const record = (kind: ExtensionSpecifierReference["kind"], literal: unknown): void => {
		const node = asAstNode(literal);
		if (
			node?.type === "StringLiteral" &&
			typeof node.value === "string" &&
			typeof node.start === "number" &&
			typeof node.end === "number"
		) {
			references.push({ kind, specifier: node.value, start: node.start, end: node.end });
		}
	};
	const createRequireBindings = new Set<string>();
	const moduleNamespaceBindings = new Set<string>();
	for (const { node } of collectScopedAstNodes(ast, candidate => candidate.type === "ImportDeclaration")) {
		const source = asAstNode(node.source);
		if (source?.type !== "StringLiteral" || (source.value !== "node:module" && source.value !== "module")) continue;
		for (const value of Array.isArray(node.specifiers) ? node.specifiers : []) {
			const specifier = asAstNode(value);
			const local = asAstNode(specifier?.local);
			if (local?.type !== "Identifier" || typeof local.name !== "string") continue;
			if (specifier?.type === "ImportNamespaceSpecifier") {
				moduleNamespaceBindings.add(local.name);
			} else if (specifier?.type === "ImportSpecifier") {
				const imported = asAstNode(specifier.imported);
				if (
					(imported?.type === "Identifier" && imported.name === "createRequire") ||
					(imported?.type === "StringLiteral" && imported.value === "createRequire")
				) {
					createRequireBindings.add(local.name);
				}
			}
		}
	}
	for (const { node, scope } of collectScopedAstNodes(ast, isSpecifierReferenceNode)) {
		if (
			node.type === "ImportDeclaration" ||
			node.type === "ExportNamedDeclaration" ||
			node.type === "ExportAllDeclaration"
		) {
			record("import", node.source);
		} else if (node.type === "ImportExpression") {
			record("import", node.source);
		} else if (node.type === "TSImportEqualsDeclaration") {
			const moduleReference = asAstNode(node.moduleReference);
			if (moduleReference?.type === "TSExternalModuleReference") {
				record("require", moduleReference.expression);
			}
		} else if (node.type === "CallExpression") {
			const callee = asAstNode(node.callee);
			if (callee?.type === "Import") {
				record("import", nodeArgument(node, 0));
			} else if (isIdentifier(callee, "require") && !scopeHasBinding(scope, REQUIRE_BINDING)) {
				record("require", nodeArgument(node, 0));
			} else if (isCreateRequireInvocation(callee, createRequireBindings, moduleNamespaceBindings)) {
				// `createRequire(base)(spec)` — pin the invoked bare dependency so it
				// loads without a runtime `node_modules` lookup. Relative specifiers
				// resolve against `base`, which is not rewritten, so restrict to bare.
				const argument = nodeArgument(node, 0);
				if (
					argument?.type === "StringLiteral" &&
					typeof argument.value === "string" &&
					isBareExtensionDependencySpecifier(argument.value)
				) {
					record("require", argument);
				}
			}
		}
	}
	return references;
}

const EXTENSION_PARSE_CACHE_SCHEMA_VERSION = 1;
const EXTENSION_PARSE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const EXTENSION_PARSE_CACHE_MAX_ENTRIES = 10_000;

interface ExtensionSourceAnalysis {
	readonly sourceType: "script" | "module";
	readonly references: readonly ExtensionSpecifierReference[];
	readonly commonJsNamedExports: readonly string[];
	readonly commonJsReexportSpecifiers: readonly string[];
}

interface ExtensionParseCacheRow {
	source_type: "script" | "module";
	references: string;
	commonjs_named_exports: string;
	commonjs_reexport_specifiers: string;
}

let extensionParseCacheDb: Database | null | undefined;
const extensionSourceAnalysisCache = new Map<string, ExtensionSourceAnalysis>();

function extensionParseCacheKey(source: string, importerPath: string): string {
	return `${EXTENSION_PARSE_CACHE_SCHEMA_VERSION}:${path.extname(importerPath).toLowerCase()}:${Bun.hash(source).toString(16)}`;
}

function getExtensionParseCacheDb(): Database | null {
	if (extensionParseCacheDb !== undefined) return extensionParseCacheDb;
	try {
		const cachePath = getLegacyPiExtensionCacheDbPath();
		try {
			if (fs.statSync(cachePath).size > EXTENSION_PARSE_CACHE_MAX_BYTES) {
				// Remove the full WAL set, not just the main db. A leftover
				// `-wal`/`-shm` pair still owned by a concurrent omp process is
				// adopted by this fresh connection; when that `-wal` has
				// uncheckpointed frames (the normal case while another omp is
				// writing its own cache entries), `journal_mode=WAL` fails with
				// SQLITE_IOERR — disabling the parse cache for the whole process
				// and forcing a reparse of every extension on startup. See #9549.
				for (const suffix of ["", "-wal", "-shm"]) {
					fs.rmSync(`${cachePath}${suffix}`, { force: true });
				}
			}
		} catch {
			// A missing or unreadable cache is a cold cache.
		}
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		const db = new Database(cachePath, { create: true });
		// Install the busy handler BEFORE any lock-taking statement (incl.
		// `PRAGMA journal_mode=WAL`, which takes an exclusive lock during WAL
		// recovery). See #2421. WAL + synchronous=NORMAL avoids the per-entry
		// journal create/delete + fsync churn that serialized this cache behind
		// concurrent omp startups and blocked the event loop for ~20s (#9549).
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		db.run("PRAGMA journal_mode=WAL");
		db.run("PRAGMA synchronous=NORMAL");
		db.run(
			"CREATE TABLE IF NOT EXISTS extension_parse_cache (cache_key TEXT PRIMARY KEY, source_type TEXT NOT NULL, [references] TEXT NOT NULL, commonjs_named_exports TEXT NOT NULL, commonjs_reexport_specifiers TEXT NOT NULL)",
		);
		extensionParseCacheDb = db;
		return db;
	} catch (error) {
		logger.debug("legacy Pi extension parse cache unavailable", {
			error: error instanceof Error ? error.message : String(error),
		});
		extensionParseCacheDb = null;
		return null;
	}
}

/**
 * Test seam: whether the extension parse cache opened successfully. Exercises
 * the real eviction + open path, including full WAL-set cleanup on oversized
 * caches (#9549).
 */
export function __isExtensionParseCacheAvailableForTests(): boolean {
	return getExtensionParseCacheDb() !== null;
}

function parseCachedAnalysis(row: ExtensionParseCacheRow): ExtensionSourceAnalysis | null {
	try {
		if (row.source_type !== "script" && row.source_type !== "module") return null;
		const references = JSON.parse(row.references) as unknown;
		const commonJsNamedExports = JSON.parse(row.commonjs_named_exports) as unknown;
		const commonJsReexportSpecifiers = JSON.parse(row.commonjs_reexport_specifiers) as unknown;
		if (
			!Array.isArray(references) ||
			!references.every(
				reference =>
					reference &&
					typeof reference === "object" &&
					(reference.kind === "import" || reference.kind === "require") &&
					typeof reference.specifier === "string" &&
					typeof reference.start === "number" &&
					typeof reference.end === "number",
			) ||
			!Array.isArray(commonJsNamedExports) ||
			!commonJsNamedExports.every(name => typeof name === "string") ||
			!Array.isArray(commonJsReexportSpecifiers) ||
			!commonJsReexportSpecifiers.every(specifier => typeof specifier === "string")
		) {
			return null;
		}
		return {
			sourceType: row.source_type,
			references: references as ExtensionSpecifierReference[],
			commonJsNamedExports,
			commonJsReexportSpecifiers,
		};
	} catch {
		return null;
	}
}

function writeExtensionSourceAnalysis(cacheKey: string, analysis: ExtensionSourceAnalysis): void {
	void Promise.resolve()
		.then(() => {
			const db = getExtensionParseCacheDb();
			if (!db) return;
			db.run(
				"INSERT OR REPLACE INTO extension_parse_cache (cache_key, source_type, [references], commonjs_named_exports, commonjs_reexport_specifiers) VALUES (?, ?, ?, ?, ?)",
				[
					cacheKey,
					analysis.sourceType,
					JSON.stringify(analysis.references),
					JSON.stringify(analysis.commonJsNamedExports),
					JSON.stringify(analysis.commonJsReexportSpecifiers),
				],
			);
			const count =
				db.query<{ count: number }, []>("SELECT count(*) AS count FROM extension_parse_cache").get()?.count ?? 0;
			if (count > EXTENSION_PARSE_CACHE_MAX_ENTRIES) {
				db.run("DELETE FROM extension_parse_cache");
			}
		})
		.catch(error => {
			logger.debug("legacy Pi extension parse cache write failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
}

function getExtensionSourceAnalysis(source: string, importerPath: string): ExtensionSourceAnalysis {
	const cacheKey = extensionParseCacheKey(source, importerPath);
	const memoryCached = extensionSourceAnalysisCache.get(cacheKey);
	if (memoryCached) return memoryCached;

	const db = getExtensionParseCacheDb();
	try {
		const row = db
			?.query<ExtensionParseCacheRow, [string]>(
				"SELECT source_type, [references], commonjs_named_exports, commonjs_reexport_specifiers FROM extension_parse_cache WHERE cache_key = ?",
			)
			.get(cacheKey);
		if (row) {
			const cached = parseCachedAnalysis(row);
			if (cached) {
				extensionSourceAnalysisCache.set(cacheKey, cached);
				return cached;
			}
		}
	} catch (error) {
		logger.debug("legacy Pi extension parse cache read failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const ast = parseExtensionSource(source, importerPath);
	const commonJs = collectCommonJsExportAnalysis(ast);
	const analysis: ExtensionSourceAnalysis = {
		sourceType: ast.program.sourceType,
		references: collectExtensionSpecifierReferences(source, importerPath, ast),
		...commonJs,
	};
	extensionSourceAnalysisCache.set(cacheKey, analysis);
	writeExtensionSourceAnalysis(cacheKey, analysis);
	return analysis;
}

function applySpecifierReplacements(
	source: string,
	replacements: ReadonlyArray<ExtensionSpecifierReference & { readonly replacement: string }>,
): string {
	let rewritten = source;
	for (const reference of [...replacements].sort((left, right) => right.start - left.start)) {
		rewritten = `${rewritten.slice(0, reference.start)}${JSON.stringify(reference.replacement)}${rewritten.slice(reference.end)}`;
	}
	return rewritten;
}

const loadedBundledModules: Record<string, BundledModule> = {};
let bundledModuleLoadersPromise: Promise<BundledModuleLoaders> | null = null;

/**
 * Load the build-supplied module registry without evaluating its host modules.
 *
 * `globalThis` bridges the synthetic ES modules, which cannot close over this
 * file's lexical scope. Dev/test runs never execute the conditional import;
 * binary builds resolve it through the in-memory build plugin.
 */
function ensureBundledModuleLoadersLoaded(): Promise<BundledModuleLoaders> {
	if (!IS_COMPILED_BINARY) {
		return Promise.reject(new Error("omp:legacy-pi-shim: bundled modules are only available in compiled mode"));
	}
	if (!bundledModuleLoadersPromise) {
		bundledModuleLoadersPromise = import("omp-legacy-pi-modules").then(module => {
			Reflect.set(globalThis, BUNDLED_MODULES_GLOBAL, loadedBundledModules);
			return module.BUNDLED_PI_MODULE_LOADERS;
		});
	}
	return bundledModuleLoadersPromise;
}

async function loadBundledModule(moduleKey: string): Promise<void> {
	const loaders = await ensureBundledModuleLoadersLoaded();
	const loader = loaders[moduleKey];
	if (!loader) {
		throw new Error(`omp:legacy-pi-shim: no bundled module registered for ${moduleKey}`);
	}
	loadedBundledModules[moduleKey] = await loader();
}

function bundledModuleVirtualSpecifier(moduleKey: string): string {
	return `${BUNDLED_VIRTUAL_SCHEME}${moduleKey}`;
}

function isBundledVirtualSpecifier(value: string): boolean {
	return value.startsWith(BUNDLED_VIRTUAL_SCHEME);
}

function toLegacyPiResolveResult(resolvedPath: string): LegacyPiResolveResult {
	if (isBundledVirtualSpecifier(resolvedPath)) {
		const registryKey = resolvedPath.slice(BUNDLED_VIRTUAL_SCHEME.length);
		return { path: registryKey, namespace: BUNDLED_VIRTUAL_NAMESPACE };
	}
	return { path: resolvedPath };
}

/** Maps a bundled virtual specifier or registry key to Bun's plugin namespace shape. */
export function resolveBundledVirtualSpecifier(specifier: string): BundledVirtualResolveResult {
	const registryKey = isBundledVirtualSpecifier(specifier)
		? specifier.slice(BUNDLED_VIRTUAL_SCHEME.length)
		: specifier;
	if (!registryKey) {
		throw new Error("omp:legacy-pi-shim: bundled virtual specifier has no registry key");
	}
	return { path: registryKey, namespace: BUNDLED_VIRTUAL_NAMESPACE };
}

/**
 * Build a synthetic ES module for one live bundled namespace. Every export
 * reads through the global bridge; no bunfs path or copied package is involved.
 */
function synthesizeBundledModuleSourceFromModules(moduleKey: string, modules: BundledModules): string {
	const mod = modules[moduleKey];
	if (!mod) {
		throw new Error(`omp:legacy-pi-shim: no bundled module registered for ${moduleKey}`);
	}
	const lines: string[] = [
		`const __omp_bundled = globalThis[${JSON.stringify(BUNDLED_MODULES_GLOBAL)}][${JSON.stringify(moduleKey)}];`,
	];
	let hasDefault = false;
	for (const exportName in mod) {
		if (exportName === "default") {
			hasDefault = true;
			continue;
		}
		lines.push(`export const ${exportName} = __omp_bundled[${JSON.stringify(exportName)}];`);
	}
	if (hasDefault) {
		lines.push("export default __omp_bundled.default;");
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Build the synthetic source served for one
 * `omp-legacy-pi-bundled:<key>` import.
 */
async function synthesizeBundledModuleSource(moduleKey: string): Promise<string> {
	await loadBundledModule(moduleKey);
	return synthesizeBundledModuleSourceFromModules(moduleKey, loadedBundledModules);
}

/** Test seam for the virtual module's named/default export forwarding. */
export function __synthesizeLegacyPiBundledSourceWithModules(
	moduleKey: string,
	modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string {
	return synthesizeBundledModuleSourceFromModules(moduleKey, modules);
}

/** Test seam for the global bridge key shared with synthetic module source. */
export function __getLegacyPiBundledModulesGlobal(): string {
	return BUNDLED_MODULES_GLOBAL;
}

// Canonical scope for in-process pi packages. Plugins published against any of
// the aliased scopes below (mariozechner's original publish, earendil-works'
// fork, or the canonical @oh-my-pi scope itself) are remapped to this scope and
// resolved against the bundled copy that ships inside the omp binary. This
// keeps plugins running against the exact runtime state of the host (single
// module registry, single tool registry, etc.) regardless of which historical
// scope name they happened to declare in their peerDependencies.
const CANONICAL_PI_SCOPE = "@oh-my-pi";

// Scopes that have historically been used to publish (or alias) the same set
// of internal pi-* packages. `@oh-my-pi` is intentionally included so direct
// canonical imports still pass through the same host-bundled package resolution
// path instead of pulling a duplicate copy from plugin node_modules.
const PI_SCOPE_ALIASES = ["oh-my-pi", "mariozechner", "earendil-works"] as const;

// Internal pi-* package basenames bundled inside the omp binary.
const PI_PACKAGE_NAMES = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"] as const;

const PI_SCOPE_ALTERNATION = PI_SCOPE_ALIASES.join("|");
const PI_PACKAGE_ALTERNATION = PI_PACKAGE_NAMES.join("|");

// Upstream `@mariozechner/*` packages exposed a few subpaths at the package
// root that we relocated under a different folder. Each entry rewrites
// `<pkg>/<from>` → `<pkg>/<to>` after the scope has been canonicalised, so
// plugins importing the upstream layout still resolve to a real file in our
// bundled copy. Entries ending in `/` rewrite the whole subtree; add new
// `pkg/from -> pkg/to` pairs whenever an upstream-only subpath breaks resolution.
const PI_SUBPATH_REMAPS: ReadonlyMap<string, string> = new Map<string, string>([
	["pi-ai/utils/oauth", "pi-ai/oauth"],
	["pi-ai/utils/oauth/", "pi-ai/oauth/"],
	["pi-ai/compat", "pi-ai"],
]);

function remapLegacyPiSubpath(rest: string): string {
	const exact = PI_SUBPATH_REMAPS.get(rest);
	if (exact) {
		return exact;
	}

	for (const [from, to] of PI_SUBPATH_REMAPS) {
		if (from.endsWith("/") && rest.startsWith(from)) {
			return `${to}${rest.slice(from.length)}`;
		}
	}

	return rest;
}

const LEGACY_PI_SPECIFIER_FILTER = new RegExp(`^@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/.*)?$`);
const LEGACY_PI_IMPORT_SPECIFIER_REGEX = new RegExp(
	`((?:from\\s+|import\\s*\\(\\s*)["'])(@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/[^"'()\\s]+)?)(["'])`,
	"g",
);
const resolvedSpecifierFallbacks = new Map<string, string>();
const SOURCE_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const SUPPORTED_PACKAGE_IMPORT_CONDITIONS = new Set(["bun", "node", "import", "default"]);
const SUPPORTED_PACKAGE_REQUIRE_CONDITIONS = new Set(["bun", "node", "require", "default"]);
const packageRootCache = new Map<string, string | null>();
const packageImportsCache = new Map<string, Record<string, unknown> | null>();
const nodePackageRootCache = new Map<string, Promise<string | null>>();
const packageManifestCache = new Map<string, Promise<Record<string, unknown> | null>>();
const bareDependencyResolutionCache = new Map<string, Promise<string | null>>();
const bareRequireResolutionCache = new Map<string, Promise<string | null>>();
const realpathCache = new Map<string, Promise<string>>();
const nativeAddonResolutionCache = new Map<string, Promise<string | null>>();
const nativeAddonRequireScanCache = new Map<string, Promise<boolean>>();

// Extensions that imported `@sinclair/typebox` directly used to resolve against a
// real `@sinclair/typebox` install. The runtime dep was replaced with the Zod-backed
// shim under `extensibility/typebox.ts`; plugins still importing the public name
// are redirected to that shim so existing extensions keep working without code
// changes. Submodules like `@sinclair/typebox/compiler` are intentionally not
// remapped — those expose TypeBox-only APIs the shim does not provide and plugins
// relying on them must vendor `@sinclair/typebox` directly.
const TYPEBOX_SPECIFIER_FILTER = /^@sinclair\/typebox$/;

/**
 * Compute the package root for the npm prebuilt `dist/cli.js` bundle.
 *
 * `bundle-dist.ts` defines `process.env.PI_BUNDLED="true"`; after bundling,
 * `import.meta.dir` points at `<package>/dist`. Do not resolve the package via
 * bare `@oh-my-pi/pi-coding-agent` here: from a global install Bun can pick an
 * older cache entry, recreating mixed-runtime plugin loading.
 */
export function __computeBundledSelfPackageRoot(metaDir: string, pathImpl: typeof path = path): string {
	const normalizedMetaDir = pathImpl.normalize(metaDir);
	if (pathImpl.basename(normalizedMetaDir) === "dist") {
		return pathImpl.resolve(metaDir, "..");
	}

	const pluginsDirSuffix = pathImpl.join("src", "extensibility", "plugins");
	if (normalizedMetaDir.endsWith(pluginsDirSuffix)) {
		return pathImpl.resolve(metaDir, "..", "..", "..");
	}

	return pathImpl.resolve(metaDir);
}

function resolveBundledSelfPackageRoot(): string | undefined {
	if (!process.env.PI_BUNDLED) return undefined;
	return __computeBundledSelfPackageRoot(import.meta.dir);
}

const BUNDLED_SELF_PACKAGE_ROOT = resolveBundledSelfPackageRoot();

function sourceShimPath(file: string): string {
	return BUNDLED_SELF_PACKAGE_ROOT
		? path.join(BUNDLED_SELF_PACKAGE_ROOT, "src", "extensibility", file)
		: path.resolve(import.meta.dir, "..", file);
}

/**
 * Resolve the coding-agent compatibility surface that composes omptype's
 * TypeBox facade with legacy `Type.Unsafe`, then drop the remap when that
 * entrypoint is missing.
 *
 * In compiled-binary mode the surface is served through the
 * `omp-legacy-pi-bundled:` virtual namespace (issue #3423). Dev, source-link,
 * and installed-package modes use the shipped source module.
 *
 * Exported for tests; production callers use `TYPEBOX_SHIM_PATH`.
 */
export function __resolveTypeBoxShimPath(
	isCompiled: boolean,
	sourcePath: string,
	pathExistsSync: (p: string) => boolean = fs.existsSync,
): string | null {
	if (isCompiled) {
		return bundledModuleVirtualSpecifier(TYPEBOX_BUNDLED_MODULE_KEY);
	}
	return pathExistsSync(sourcePath) ? sourcePath : null;
}

const TYPEBOX_SHIM_PATH = __resolveTypeBoxShimPath(IS_COMPILED_BINARY, sourceShimPath("legacy-typebox.ts"));

// Legacy extensions historically imported `Type` (and `Static`/`TSchema`) from
// the package root of `@(scope)/pi-ai`. pi-ai 15.1.0 removed the runtime `Type`
// export (see `packages/ai/CHANGELOG.md`), so the bare canonical specifier no
// longer satisfies those imports. The override below redirects only the bare
// pi-ai package root onto a sibling shim that re-exports the canonical surface
// plus the borrowed `Type` runtime from the omptype TypeBox facade. Subpath
// imports such as `@oh-my-pi/pi-ai/oauth` continue to resolve directly
// against the bundled pi-ai package.
const LEGACY_PI_AI_SHIM_PATH = IS_COMPILED_BINARY
	? bundledModuleVirtualSpecifier(`${CANONICAL_PI_SCOPE}/pi-ai`)
	: sourceShimPath("legacy-pi-ai-shim.ts");

// The coding-agent's own `./src/index.ts` cannot be listed as an extra
// `bun --compile` entrypoint alongside the CLI entry without breaking binary
// startup (issue #1474 follow-up). In compiled-binary mode the legacy
// `@(scope)/pi-coding-agent` root therefore resolves through the bundled
// module shim; in dev / source-link / installed-package mode it points at the
// sibling source shim whose distinct file path avoids the #1474 collision
// while still re-exporting the canonical package surface.
const LEGACY_PI_CODING_AGENT_SHIM_PATH = IS_COMPILED_BINARY
	? bundledModuleVirtualSpecifier(`${CANONICAL_PI_SCOPE}/pi-coding-agent`)
	: sourceShimPath("legacy-pi-coding-agent-shim.ts");

// Legacy pi-tui exported `decodeKittyPrintable` from its package root. The
// canonical TUI replaced it with the broader `decodePrintableKey`; route only
// legacy root imports through a sibling shim that preserves the old name.
const LEGACY_PI_TUI_SHIM_PATH = IS_COMPILED_BINARY
	? bundledModuleVirtualSpecifier(`${CANONICAL_PI_SCOPE}/pi-tui`)
	: sourceShimPath("legacy-pi-tui-shim.ts");

// Package-root overrides. Shim entries (`pi-ai`, `pi-coding-agent`, `pi-tui`)
// always replace the canonical surface so legacy helpers stay reachable. The
// other bundled host packages (`pi-agent-core`, `pi-natives`, `pi-utils`) are
// added only in compiled-binary mode to route extensions onto the in-process
// module instance — in dev / source-link / installed-package mode the canonical
// specifier resolves cleanly through `Bun.resolveSync` and hardcoding a
// source-tree path would miss installs where bundled packages live at
// `node_modules/@oh-my-pi/pi-*`.
//
// Compiled-binary entries are `omp-legacy-pi-bundled:<key>` specifiers handed
// to the synthetic onLoad in `installLegacyPiSpecifierShim()` — bunfs paths
// are unusable on Bun 1.3.14+ (issue #3423). Filesystem-shaped overrides are
// still validated against on-disk presence so a missing dev-mode shim falls
// through to `getResolvedSpecifier`.

/**
 * Drop overrides whose filesystem targets are missing so they can fall
 * through to the canonical-resolution path. Virtual `omp-legacy-pi-bundled:`
 * entries always pass — live bundled module references are the source of truth
 * in compiled mode where bunfs paths are unreachable (issue #3423).
 *
 * `pathExistsSync` defaults to `fs.existsSync`; tests inject a stub to
 * simulate the missing-entrypoint failure mode without touching the real FS.
 */
export function __validateLegacyPiPackageRootOverrides(
	candidates: Record<string, string>,
	pathExistsSync: (p: string) => boolean = fs.existsSync,
): Record<string, string> {
	const valid: Record<string, string> = {};
	for (const key in candidates) {
		const candidate = candidates[key];
		if (candidate && (isBundledVirtualSpecifier(candidate) || pathExistsSync(candidate))) {
			valid[key] = candidate;
		}
	}
	return valid;
}

/**
 * Compute the override map keyed by every canonical specifier the host serves
 * directly: the pi-ai / pi-coding-agent roots (compat shims that re-attach
 * legacy helpers) plus, in compiled mode, every build-supplied module key.
 * Subpath coverage stops `@(scope)/pi-ai/oauth` and friends from falling
 * through to the extension's absent peer install when bunfs walks fail.
 */
export function __buildLegacyPiPackageRootOverrides(
	isCompiled: boolean,
	bundledModuleKeys: Iterable<string> = [],
): Record<string, string> {
	const candidates: Record<string, string> = {
		[`${CANONICAL_PI_SCOPE}/pi-ai`]: LEGACY_PI_AI_SHIM_PATH,
		[`${CANONICAL_PI_SCOPE}/pi-coding-agent`]: LEGACY_PI_CODING_AGENT_SHIM_PATH,
		[`${CANONICAL_PI_SCOPE}/pi-tui`]: LEGACY_PI_TUI_SHIM_PATH,
	};
	if (isCompiled) {
		for (const key of bundledModuleKeys) {
			// Shim-bearing roots already map to their compat surfaces; TypeBox
			// has a dedicated TYPEBOX_SHIM_PATH route.
			if (key in candidates || key === TYPEBOX_BUNDLED_MODULE_KEY) continue;
			candidates[key] = bundledModuleVirtualSpecifier(key);
		}
	}
	return __validateLegacyPiPackageRootOverrides(candidates);
}

// Seeded with compat roots at module init; first compiled extension load adds
// every key supplied by the in-memory build module.
let legacyPiPackageRootOverrides = __buildLegacyPiPackageRootOverrides(IS_COMPILED_BINARY);
let legacyPiOverridesReadyPromise: Promise<void> | null = null;

/** Complete compiled-mode overrides from the lazy host-module registry. */
function ensureLegacyPiOverridesReady(): Promise<void> {
	if (!IS_COMPILED_BINARY) {
		return Promise.resolve();
	}
	if (!legacyPiOverridesReadyPromise) {
		legacyPiOverridesReadyPromise = ensureBundledModuleLoadersLoaded().then(loaders => {
			legacyPiPackageRootOverrides = __buildLegacyPiPackageRootOverrides(true, Object.keys(loaders));
		});
	}
	return legacyPiOverridesReadyPromise;
}

let isLegacyPiSpecifierShimInstalled = false;

function remapLegacyPiSpecifier(specifier: string): string | null {
	if (!LEGACY_PI_SPECIFIER_FILTER.test(specifier)) {
		return null;
	}
	const slashIdx = specifier.indexOf("/", 1);
	// Filter guarantees a slash exists, but guard anyway to keep the type narrow.
	if (slashIdx === -1) {
		return null;
	}
	const rest = specifier.slice(slashIdx + 1);
	const remappedSubpath = remapLegacyPiSubpath(rest);
	return `${CANONICAL_PI_SCOPE}/${remappedSubpath}`;
}

function getResolvedSpecifier(specifier: string): string {
	const cached = resolvedSpecifierFallbacks.get(specifier);
	if (cached) {
		return cached;
	}

	const resolved = Bun.resolveSync(specifier, import.meta.dir);
	resolvedSpecifierFallbacks.set(specifier, resolved);
	return resolved;
}

/**
 * Resolve a canonical `@oh-my-pi/*` specifier to a filesystem path, preferring
 * a bundled compat shim when one is registered for the package root.
 *
 * Falls back to `getResolvedSpecifier` (which may throw under compiled binary
 * mode); callers handle that the same way they would for non-overridden
 * specifiers.
 */
function resolveCanonicalPiSpecifier(remappedSpecifier: string): string {
	const override = legacyPiPackageRootOverrides[remappedSpecifier];
	if (override) {
		return override;
	}
	return getResolvedSpecifier(remappedSpecifier);
}

function toImportSpecifier(resolvedPath: string): string {
	// Virtual `omp-legacy-pi-bundled:` specifiers are served by the synthetic
	// onLoad in `installLegacyPiSpecifierShim()`; wrapping them as `file://`
	// would corrupt the scheme.
	if (isBundledVirtualSpecifier(resolvedPath)) {
		return resolvedPath;
	}
	return url.pathToFileURL(stripWindowsExtendedLengthPathPrefix(resolvedPath)).href;
}

/**
 * Rewrite the extension-owned specifiers OMP must host-resolve — legacy
 * `@(scope)/pi-*`, bare TypeBox packages, package `imports` aliases like
 * `#src/*`, and extension-local bare dependencies — to absolute `file://` URLs
 * or compiled-mode virtual specifiers. Relative siblings and built-in modules
 * are left untouched so Bun resolves them from the extension's real on-disk
 * location.
 *
 * When `mtimeTag` is provided, extension-owned relative graph specifiers
 * (`./`/`../`) and, by default, resolved package `#alias/*` and extension-local
 * bare deps also carry a `?mtime=<tag>` cache-bust so Bun rekeys them on
 * same-process reloads. `resolvedImportMtimeTag` can disable the tag for
 * resolved package and bare ESM imports inside third-party dependencies, whose
 * transitive ESM imports retain a query-free importer path for Bun's runtime
 * `node_modules` resolution. Host package rewrites (legacy
 * `@(scope)/pi-*`, TypeBox shim) always emit `file://` URLs because they resolve
 * to in-process host code that never changes between reloads.
 */
async function rewriteLegacyExtensionSource(
	source: string,
	importerPath: string,
	mtimeTag: string | null = null,
	resolvedImportMtimeTag: string | null = mtimeTag,
): Promise<string> {
	// Compiled mode completes the override map from the build-supplied module
	// keys on first use; every rewrite path must see the full map.
	await ensureLegacyPiOverridesReady();
	const references = getExtensionSourceAnalysis(source, importerPath).references;
	const replacements: Array<ExtensionSpecifierReference & { replacement: string }> = [];
	for (const reference of references) {
		if (reference.kind !== "import") continue;

		const specifier = reference.specifier;
		let replacement: string | null = null;
		const remappedSpecifier = remapLegacyPiSpecifier(specifier);
		if (remappedSpecifier) {
			try {
				replacement = toImportSpecifier(resolveCanonicalPiSpecifier(remappedSpecifier));
			} catch {
				// Resolution failed — typically in compiled binary mode where
				// Bun.resolveSync cannot walk up from /$bunfs/root to find the
				// bundled node_modules. Leave the specifier unchanged so Bun
				// resolves it natively against the extension's own peer deps.
				return match;
			}
		},
	);
}

// Match the bare `@sinclair/typebox` import specifier (static + dynamic).
// Subpath imports like `@sinclair/typebox/compiler` are intentionally excluded —
// they expose TypeBox-only APIs the Zod-backed shim does not provide.
const TYPEBOX_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s*\(\s*)["'])(@sinclair\/typebox)(["'])/g;

/**
 * Rewrite the legacy specifiers a Pi extension may import — `@(scope)/pi-*` and
 * the bare `@sinclair/typebox` root — to absolute `file://` URLs pointing at the
 * bundled package or compat shim. Every other specifier (relative siblings, the
 * extension's own bare dependencies) is left untouched so Bun resolves it
 * natively from the extension's real on-disk location.
 */
function rewriteLegacyExtensionSource(source: string): string {
	const withPi = rewriteLegacyPiImports(source);
	return withPi.replace(
		TYPEBOX_IMPORT_SPECIFIER_REGEX,
		(_match, prefix: string, _specifier: string, suffix: string) => {
			return `${prefix}${toImportSpecifier(TYPEBOX_SHIM_PATH)}${suffix}`;
		},
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match relative import specifiers (static `from "./…"` and dynamic
// `import("./…")`). Used to walk an extension's own module graph; bare and
// absolute specifiers are deliberately excluded.
const RELATIVE_IMPORT_SPECIFIER_REGEX = /(?:from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+)["']/g;

// Extension entry realpaths that already have a load-time rewrite hook
// installed. Each `Bun.plugin()` registration is process-global and permanent,
// so we register at most one hook per entry.
const hookedExtensionEntries = new Set<string>();

/** Resolve symlinks in a path, falling back to the input if realpath fails. */
async function realpathOrSelf(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return p;
	}
}

/**
 * Walk the extension's relative-import graph starting at `entryRealPath`,
 * returning the realpath of every reachable source module. Only relative
 * specifiers (`./`, `../`) are followed — bare and absolute imports are left to
 * Bun's native resolver — so the set is exactly the extension's own source,
 * wherever it physically lives (a `../src` sibling, a symlinked sub-tree, …).
 * This mirrors the module set the old temp-dir mirror tracked, minus the copy.
 */
async function collectExtensionModules(entryRealPath: string): Promise<Set<string>> {
	const modules = new Set<string>();
	const queue = [entryRealPath];
	while (queue.length > 0) {
		const file = queue.pop();
		if (!file || modules.has(file)) {
			continue;
		}
		let source: string;
		try {
			source = await Bun.file(file).text();
		} catch {
			continue;
		}
		modules.add(file);
		const dir = path.dirname(file);
		for (const match of source.matchAll(RELATIVE_IMPORT_SPECIFIER_REGEX)) {
			try {
				const resolved = await realpathOrSelf(Bun.resolveSync(match[1], dir));
				if (!modules.has(resolved)) {
					queue.push(resolved);
				}
			} catch {
				// Unresolvable relative import (e.g. a type-only path); skip it.
			}
		}
	}
	return modules;
}

/**
 * Install a `Bun.plugin()` `onLoad` hook scoped to exactly the modules in an
 * extension's relative-import graph, so their legacy `@(scope)/pi-*` and bare
 * `@sinclair/typebox` imports are rewritten at load time. A runtime `onLoad`
 * cannot fall through (Bun requires a result object), so the filter is an
 * exact-path alternation of the graph's realpaths — it never matches the host,
 * other extensions, `node_modules` deps, or unrelated project source.
 */
async function ensureExtensionGraphHook(entryRealPath: string): Promise<void> {
	if (hookedExtensionEntries.has(entryRealPath)) {
		return;
	}
	hookedExtensionEntries.add(entryRealPath);

	const modules = await collectExtensionModules(entryRealPath);
	const alternation = [...modules].map(escapeRegExp).join("|");
	const filter = new RegExp(`^(?:${alternation})$`);
	Bun.plugin({
		name: `omp:legacy-pi-ext:${Bun.hash(entryRealPath).toString(36)}`,
		setup(build) {
			build.onLoad({ filter, namespace: "file" }, async args => {
				// Re-read on every load so a `?mtime` reload picks up edited source.
				const raw = await Bun.file(args.path).text();
				return { contents: rewriteLegacyExtensionSource(raw), loader: getLoader(args.path) };
			});
		},
	});
}

/**
 * Load a legacy Pi extension module from its real on-disk location.
 *
 * The extension runs in place, so its `import.meta.url` is the real source file
 * and `__dirname`-relative `readFileSync` asset loads (HTML/CSS bundled next to
 * the entry) resolve exactly as they do under the original Pi runtime — no
 * temp-directory mirroring and no asset copying. An `onLoad` hook scoped to the
 * entry's relative-import graph rewrites only the legacy `@(scope)/pi-*` and
 * `@sinclair/typebox` imports in the extension's own source; everything else
 * resolves natively.
 */
export async function loadLegacyPiModule(resolvedPath: string): Promise<unknown> {
	// Bun reports the realpath of a loaded module to `onLoad` and exposes it as
	// `import.meta.url`. Resolve symlinks here too (macOS `/var`→`/private/var`,
	// `bun link`/pnpm installs) so the rewrite filter matches the path Bun
	// actually hands the hook.
	const entryRealPath = await realpathOrSelf(path.resolve(resolvedPath));
	await ensureExtensionGraphHook(entryRealPath);
	// `?mtime` busts Bun's module cache so repeat loads pick up edited source.
	return import(`${toImportSpecifier(entryRealPath)}?mtime=${Date.now()}`);
}

function getLoader(path: string): "js" | "jsx" | "ts" | "tsx" {
	if (path.endsWith(".tsx")) {
		return "tsx";
	}
	if (path.endsWith(".jsx")) {
		return "jsx";
	}
	if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
		return "ts";
	}
	return "js";
}

function resolveLegacyPiSpecifier(args: { path: string; importer: string }): LegacyPiResolveResult | undefined {
	const remappedSpecifier = remapLegacyPiSpecifier(args.path);
	if (!remappedSpecifier) {
		return undefined;
	}

	// Primary: resolve the canonical @oh-my-pi/* specifier from the host binary
	// location. Works in dev mode and in source-link installs.
	try {
		return toLegacyPiResolveResult(resolveCanonicalPiSpecifier(remappedSpecifier));
	} catch {
		// Fallback for compiled binary mode: the bundled packages live inside
		// /$bunfs/root and aren't reachable by filesystem resolution. Prefer the
		// canonical specifier against the importing file's directory when the
		// plugin installed @oh-my-pi peer deps, then try the original legacy
		// specifier for plugins that still vendor only @mariozechner or
		// @earendil-works peer deps.
		const importerDir = path.dirname(args.importer);
		try {
			return toLegacyPiResolveResult(Bun.resolveSync(remappedSpecifier, importerDir));
		} catch {
			try {
				return toLegacyPiResolveResult(Bun.resolveSync(args.path, importerDir));
			} catch {
				return undefined;
			}
		}
	}
}

function resolveTypeBoxSpecifier(): LegacyPiResolveResult | undefined {
	return TYPEBOX_SHIM_PATH ? toLegacyPiResolveResult(TYPEBOX_SHIM_PATH) : undefined;
}

export function installLegacyPiSpecifierShim(): void {
	if (isLegacyPiSpecifierShimInstalled) {
		return;
	}
	isLegacyPiSpecifierShimInstalled = true;

	Bun.plugin({
		name: "omp:legacy-pi-shim",
		setup(build) {
			build.onResolve({ filter: LEGACY_PI_SPECIFIER_FILTER, namespace: "file" }, resolveLegacyPiSpecifier);
			build.onResolve({ filter: TYPEBOX_SPECIFIER_FILTER, namespace: "file" }, resolveTypeBoxSpecifier);
		},
	});
}

/** Test seam: clears the memoized canonical specifier resolutions. */
export function __resetLegacyPiResolutionCache(): void {
	clearLegacyPiResolutionCaches();
}
