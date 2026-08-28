import { parseDevice, parseEngines, parseMarket } from "./config.ts";
import type { SerpDevice, SerpEngine, SerpMarket } from "./types.ts";

export type CliCommand = "scan" | "serp" | "ideas" | "gap" | "doctor" | "help" | "version";

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
  error?: string;
};

const COMMANDS: CliCommand[] = ["scan", "serp", "ideas", "gap", "doctor", "help", "version"];
const FORMATS: CliFormat[] = ["text", "json", "csv", "html", "disavow"];

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
      case "market":
        options.market = parseMarket(next(), options.market);
        break;
      case "d":
      case "device":
        options.device = parseDevice(next(), options.device);
        break;
      case "e":
      case "engine":
      case "engines":
        options.engines = parseEngines(next(), options.engines);
        break;
      case "depth":
        options.depth = Number(next()) >= 20 ? 20 : 10;
        break;
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
  // `doctor` diagnoses the tool itself, so it needs no target.
  if (options.command === "doctor") return options;

  if (!options.target) {
    return { ...options, error: "Provide a domain, e.g. `rankproof scan example.com`." };
  }
  if (options.command === "serp" && options.keywords.length === 0) {
    return { ...options, error: "The `serp` command requires keywords: --keywords \"first,second\"." };
  }
  if (options.command === "ideas" && options.keywords.length === 0) {
    return { ...options, error: "The `ideas` command requires seed keywords: --keywords \"keyword\"." };
  }
  if (options.command === "gap" && options.competitors.length === 0) {
    return { ...options, error: "The `gap` command requires competitors: --competitors \"a.com,b.com\"." };
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
  GOOGLE_OAUTH_* and BING_WEBMASTER_API_KEY add measured performance data.

Full documentation: docs/cli.md`;
