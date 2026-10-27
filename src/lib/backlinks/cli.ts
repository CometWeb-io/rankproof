import { parseEngines, type ScanProfile } from "./config.ts";
import type { SerpDevice, SerpEngine, SerpMarket } from "./types.ts";

export type CliCommand =
  | "scan"
  | "serp"
  | "ideas"
  | "gap"
  | "doctor"
  | "analyze"
  | "graph"
  | "citations"
  | "ledger"
  | "capture"
  | "replay"
  | "render"
  | "help"
  | "version";

export type CliFormat = "text" | "json" | "csv" | "html" | "disavow";

export type CliOptions = {
  command: CliCommand;
  target: string;
  keywords: string[];
  competitors: string[];
  market: SerpMarket;
  device: SerpDevice;
  engines: SerpEngine[];
  depth: number;
  format: CliFormat;
  out: string | null;
  quiet: boolean;
  /** Skips the internal crawl during `scan`. */
  skipAudit: boolean;
  includeWebmaster: boolean;
  profile?: ScanProfile;
  error?: string;
};

const COMMANDS: CliCommand[] = [
  "scan",
  "serp",
  "ideas",
  "gap",
  "doctor",
  "analyze",
  "graph",
  "citations",
  "ledger",
  "capture",
  "replay",
  "render",
  "help",
  "version",
];
const FORMATS: CliFormat[] = ["text", "json", "csv", "html", "disavow"];
const MARKETS: SerpMarket[] = ["pl", "us", "gb", "de", "fr", "es"];
const DEVICES: SerpDevice[] = ["desktop", "mobile"];
const DEPTHS = [10, 20] as const;

function splitList(value: string): string[] {
  return value
    .split(/[,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The CLI argument parser. Kept separate from process entry so it can be tested
 * without running a scan — argument handling is the most common source of silent
 * bugs in command-line tools.
 *
 * Supports `--key value`, `--key=value` and valueless flags.
 */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "help",
    target: "",
    keywords: [],
    competitors: [],
    market: "pl",
    device: "desktop",
    engines: [],
    depth: 10,
    format: "text",
    out: null,
    quiet: false,
    skipAudit: false,
    includeWebmaster: false,
  };

  const args = [...argv];
  const first = args[0];
  if (first && !first.startsWith("-")) {
    if (COMMANDS.includes(first as CliCommand)) {
      options.command = first as CliCommand;
      args.shift();
    } else {
      // `rankproof example.com` without a command = scan.
      options.command = "scan";
    }
  } else if (first === undefined) {
    return options;
  }

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^--?/, "");
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = () => {
      if (inlineValue !== undefined) return inlineValue;
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) return "";
      i += 1;
      return value;
    };

    switch (key) {
      case "h":
      case "help":
        options.command = "help";
        break;
      case "v":
      case "version":
        options.command = "version";
        break;
      case "k":
      case "keyword":
      case "keywords":
        options.keywords.push(...splitList(next()));
        break;
      case "c":
      case "competitor":
      case "competitors":
        options.competitors.push(...splitList(next()));
        break;
      case "m":
      case "market": {
        const value = next().trim().toLowerCase();
        if (!MARKETS.includes(value as SerpMarket)) {
          options.error = `Unknown market: ${value || "(empty)"}. Available: ${MARKETS.join(", ")}.`;
        } else {
          options.market = value as SerpMarket;
        }
        break;
      }
      case "d":
      case "device": {
        const value = next().trim().toLowerCase();
        if (!DEVICES.includes(value as SerpDevice)) {
          options.error = `Unknown device: ${value || "(empty)"}. Available: ${DEVICES.join(", ")}.`;
        } else {
          options.device = value as SerpDevice;
        }
        break;
      }
      case "e":
      case "engine":
      case "engines":
        options.engines = parseEngines(next(), options.engines);
        break;
      case "depth": {
        const raw = next().trim();
        const value = Number(raw);
        if (!DEPTHS.includes(value as (typeof DEPTHS)[number])) {
          options.error = `Unknown depth: ${raw || "(empty)"}. Available: ${DEPTHS.join(", ")}.`;
        } else {
          options.depth = value;
        }
        break;
      }
      case "f":
      case "format": {
        const value = next().toLowerCase();
        if (FORMATS.includes(value as CliFormat)) options.format = value as CliFormat;
        else options.error = `Unknown format: ${value}. Available: ${FORMATS.join(", ")}.`;
        break;
      }
      case "json":
        options.format = "json";
        break;
      case "o":
      case "out":
      case "output":
        options.out = next() || null;
        break;
      case "q":
      case "quiet":
        options.quiet = true;
        break;
      case "no-audit":
      case "skip-audit":
        options.skipAudit = true;
        break;
      case "webmaster":
        options.includeWebmaster = true;
        break;
      case "profile": {
        const value = next();
        if (value === "quick" || value === "standard" || value === "deep") options.profile = value;
        else options.error = "Unknown profile. Available: quick, standard, deep.";
        break;
      }
      default:
        options.error = `Unknown option: --${key}`;
    }
  }

  options.target = positional[0] ?? "";

  // Keywords may also be given positionally, either as separate words or as
  // one comma-separated string — the form every documented example uses:
  // `rankproof serp example.com "packshot,product photography"`.
  if ((options.command === "serp" || options.command === "ideas") && positional.length > 1) {
    options.keywords.push(...positional.slice(1).flatMap((value) => splitList(value)));
  }
  if (options.command === "gap" && positional.length > 1) {
    options.competitors.push(...positional.slice(1).flatMap((value) => splitList(value)));
  }

  return validate(options);
}

function validate(options: CliOptions): CliOptions {
  if (options.error) return options;
  if (options.command === "help" || options.command === "version") return options;
  if (options.includeWebmaster && options.command !== "scan") {
    return { ...options, error: "--webmaster is only available for a local scan." };
  }
  if (options.profile && options.command !== "scan") {
    return { ...options, error: "--profile is only available for a scan." };
  }
  // `doctor` diagnoses the tool itself, so it needs no target.
  if (options.command === "doctor") return options;

  if (
    ["analyze", "graph", "citations", "ledger", "capture", "replay", "render"].includes(
      options.command,
    )
  ) {
    if (!options.target)
      return { ...options, error: `Provide an input JSON file for ${options.command}.` };
    if (["capture", "render"].includes(options.command) && !options.out)
      return {
        ...options,
        error: `${options.command} requires --out with a new private file path.`,
      };
    if (options.command === "graph" && options.format === "csv") return options;
    if (options.format !== "text" && options.format !== "json") {
      return { ...options, error: `${options.command} produces JSON; use --format json.` };
    }
    return options;
  }
  if (!options.target) {
    return { ...options, error: "Provide a domain, e.g. `rankproof scan example.com`." };
  }
  if (options.command === "serp" && options.keywords.length === 0) {
    return {
      ...options,
      error: 'The `serp` command requires keywords: --keywords "first,second".',
    };
  }
  if (options.command === "ideas" && options.keywords.length === 0) {
    return {
      ...options,
      error: 'The `ideas` command requires seed keywords: --keywords "keyword".',
    };
  }
  if (options.command === "gap" && options.competitors.length === 0) {
    return {
      ...options,
      error: 'The `gap` command requires competitors: --competitors "a.com,b.com".',
    };
  }
  if (options.command !== "scan" && (options.format === "html" || options.format === "disavow")) {
    return {
      ...options,
      error: `Format ${options.format} is only available for the \`scan\` command.`,
    };
  }
  return options;
}

export const HELP = `RankProof — SERP and link profile auditing without paid APIs.

USAGE
  rankproof <command> <domain> [options]

COMMANDS
  scan <domain>              Full audit: links, SERP, risk, action plan.
  serp <domain> [keywords]   Positions for the given keywords.
  ideas <domain> [keywords]  Keyword ideas from search-engine autocomplete.
  gap <domain> [competitors] Domains linking to competitors but not to you.
  doctor                     Checks whether engines and parsers still work.
  analyze <report.json>     Evidence-backed decisions from an exported scan, offline.
  graph <report.json>       Export retained technical graph, or repair URLs with --format csv.
  citations <samples.json>  Replay a citation dataset, offline.
  ledger <report.json>      Export an integrity-hashed evidence ledger, offline.
  capture <pairs.json>      Explicit private HTML capture; requires --out <new-file>.
  replay <capture.json>     Re-extract and verify captured HTML, offline.
  render <request.json>     Optional qualified Chromium snapshot; requires --out <new-file>.
  help, version

OPTIONS
  -k, --keywords <list>      Comma-separated keywords.
  -c, --competitors <list>   Comma-separated competitor domains (max 5).
  -m, --market <code>        pl | us | gb | de | fr | es    (default pl)
  -d, --device <type>        desktop | mobile               (default desktop)
  -e, --engines <list>       bing,duckduckgo,mojeek,brave[,google]
      --depth <10|20>        SERP depth                     (default 10)
  -f, --format <type>        text | json | csv | html | disavow
      --json                 Shorthand for --format json.
  -o, --out <file>           Write the result to a file instead of stdout.
  -q, --quiet                No progress output or commentary.
      --no-audit             Skip the crawl of your own site (faster scan).
      --profile <name>       quick | standard | deep scan workload.
      --webmaster            Explicitly allow local scan to read configured private GSC/Bing data.

EXAMPLES
  rankproof scan example.com --market us --format json --out report.json
  rankproof serp example.com "packshot,product photography" --depth 20
  rankproof gap example.com --competitors "rival.com,other.com" --format csv
  rankproof scan example.com --format disavow --out disavow.txt
  rankproof doctor

ENVIRONMENT VARIABLES
  RANKPROOF_SCAN_BUDGET_MS, RANKPROOF_HOST_CONCURRENCY, RANKPROOF_ENGINES,
  RANKPROOF_MARKET, RANKPROOF_DEVICE, RANKPROOF_MAX_BACKLINKS,
  RANKPROOF_PERSIST_HISTORY, RANKPROOF_CACHE_DIR, RANKPROOF_GOOGLE_PROVIDER_URL,
  DATABASE_URL
  GOOGLE_OAUTH_* and BING_WEBMASTER_API_KEY require scan --webmaster.

Full documentation: docs/cli.md`;
