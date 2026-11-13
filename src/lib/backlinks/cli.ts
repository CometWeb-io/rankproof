import { parseEngines } from "./config.ts";
import type { SerpDevice, SerpEngine, SerpMarket } from "./types.ts";

export type CliCommand =
  | "scan"
  | "serp"
  | "ideas"
  | "gap"
  | "verify"
  | "replay"
  | "history"
  | "export-warc"
  | "corpus"
  | "report"
  | "mcp"
  | "seal"
  | "check-seal"
  | "keygen"
  | "doctor"
  | "help"
  | "version";

export type CliFormat = "text" | "json" | "csv" | "html" | "disavow" | "markdown";

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
  /** `verify`: a previous run (JSON) to compare against. */
  previous: string | null;
  /** `verify`: store fetched HTML here; `replay`: read it from here. */
  captureDir: string | null;
  /** `verify`: exit 3 unless every pair meets its contract. */
  strict: boolean;
  /** `verify`: store runs and evidence here and compare with the latest run. */
  history: string | null;
  /** `verify`: POST a summary here when any pair changed. */
  webhook: string | null;
  /** `verify --history`: how many run documents to keep. */
  keep: number;
  /** `seal`: Ed25519 private key (PEM). */
  key: string | null;
  /** `seal`: RFC 3161 Time Stamping Authority URL. */
  tsa: string | null;
  /** `seal`: ask the Internet Archive to capture every source page. */
  wayback: boolean;
  /** `check-seal`: seal file (default <file>.seal.json). */
  seal: string | null;
  /** `check-seal`: expected signer public key (PEM). */
  publicKey: string | null;
  /** `keygen`: overwrite an existing key pair. */
  force: boolean;
  /** `verify`: JSONL progress file; an interrupted run resumes from it. */
  checkpoint: string | null;
  /** `verify`: re-check in headless Chromium; `replay`: re-render stored HTML offline. */
  render: "off" | "fallback" | "always";
  error?: string;
};

const COMMANDS: CliCommand[] = [
  "scan",
  "serp",
  "ideas",
  "gap",
  "verify",
  "replay",
  "history",
  "export-warc",
  "corpus",
  "report",
  "mcp",
  "seal",
  "check-seal",
  "keygen",
  "doctor",
  "help",
  "version",
];
const FORMATS: CliFormat[] = ["text", "json", "csv", "html", "disavow", "markdown"];
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
    previous: null,
    captureDir: null,
    strict: false,
    history: null,
    webhook: null,
    keep: 200,
    render: "off",
    checkpoint: null,
    key: null,
    tsa: null,
    wayback: false,
    force: false,
    seal: null,
    publicKey: null,
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
    // A lone "-" means stdin (e.g. `rankproof verify -`), not an option.
    if (!arg.startsWith("-") || arg === "-") {
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
      case "previous":
      case "compare":
        options.previous = next() || null;
        if (!options.previous) options.error = "--previous needs a JSON file from an earlier run.";
        break;
      case "capture-dir":
      case "capture":
        options.captureDir = next() || null;
        if (!options.captureDir) options.error = "--capture-dir needs a directory.";
        break;
      case "strict":
        options.strict = true;
        break;
      case "force":
        options.force = true;
        break;
      case "history":
        options.history = next() || null;
        if (!options.history) options.error = "--history needs a directory.";
        break;
      case "webhook":
        options.webhook = next() || null;
        if (!options.webhook || !/^https?:\/\//i.test(options.webhook)) {
          options.error = "--webhook needs an http(s) URL.";
        }
        break;
      case "key":
        options.key = next() || null;
        if (!options.key) options.error = "--key needs a PEM file (rankproof keygen).";
        break;
      case "tsa":
        options.tsa = next() || null;
        if (!options.tsa || !/^https?:\/\//i.test(options.tsa)) {
          options.error = "--tsa needs an http(s) URL of an RFC 3161 Time Stamping Authority.";
        }
        break;
      case "wayback":
        options.wayback = true;
        break;
      case "seal":
        options.seal = next() || null;
        if (!options.seal) options.error = "--seal needs a seal file.";
        break;
      case "public-key":
        options.publicKey = next() || null;
        if (!options.publicKey) options.error = "--public-key needs a PEM file.";
        break;
      case "checkpoint":
      case "resume":
        options.checkpoint = next() || null;
        if (!options.checkpoint) options.error = "--checkpoint needs a file path (JSONL).";
        break;
      case "render": {
        const value = (inlineValue ?? "fallback").toLowerCase();
        if (value !== "fallback" && value !== "always") {
          options.error = "--render takes no value, or --render=always.";
        } else {
          options.render = value;
        }
        break;
      }
      case "keep": {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 1 || value > 100_000) {
          options.error = "--keep needs a whole number of runs (1–100000).";
        } else {
          options.keep = value;
        }
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
  // `doctor` diagnoses the tool itself, so it needs no target; `mcp` speaks on stdio.
  if (options.command === "doctor" || options.command === "mcp") return options;
  if (options.force && options.command !== "keygen") {
    return { ...options, error: "--force applies to `keygen` only." };
  }

  if (
    options.command !== "seal" &&
    options.command !== "check-seal" &&
    options.command !== "keygen" &&
    (options.key || options.tsa || options.wayback || options.seal || options.publicKey)
  ) {
    return {
      ...options,
      error: "--key, --tsa, --wayback, --seal and --public-key apply to seal/check-seal.",
    };
  }
  if (options.command === "verify") {
    if (!options.target) {
      return {
        ...options,
        error: "Provide a pairs file, e.g. `rankproof verify links.csv` (or `-` for stdin).",
      };
    }
    if (options.format === "disavow") {
      return { ...options, error: "Format disavow is only available for the `scan` command." };
    }
    return options;
  }
  if (options.command === "replay") {
    if (!options.target || !options.captureDir) {
      return {
        ...options,
        error: "Usage: `rankproof replay run.json --capture-dir evidence/`.",
      };
    }
    if (options.format === "csv" || options.format === "html" || options.format === "disavow") {
      return { ...options, error: "replay supports --format text or json." };
    }
    return options;
  }
  if (options.command === "keygen") {
    if (!options.out)
      return {
        ...options,
        error: "Usage: `rankproof keygen --out signing-key` (writes .pem and .pub.pem).",
      };
    return options;
  }
  if (options.command === "seal" || options.command === "check-seal") {
    if (!options.target) {
      return { ...options, error: `Usage: \`rankproof ${options.command} run.json\`.` };
    }
    if (options.command === "seal" && (options.seal || options.publicKey)) {
      return { ...options, error: "--seal and --public-key belong to check-seal." };
    }
    if (options.command === "check-seal" && (options.key || options.tsa || options.wayback)) {
      return { ...options, error: "--key, --tsa and --wayback belong to seal." };
    }
    return options;
  }
  if (options.command === "report") {
    if (!options.target) {
      return {
        ...options,
        error: "Usage: `rankproof report run.json --format html|csv|text|markdown`.",
      };
    }
    if (options.format === "disavow")
      return { ...options, error: "report: use text, json, csv, html or markdown." };
    return options;
  }
  if (options.command === "corpus") {
    if (!options.target || !options.captureDir) {
      return {
        ...options,
        error: "Usage: `rankproof corpus run.json --capture-dir evidence/ --out cases.json`.",
      };
    }
    return options;
  }
  if (options.command === "export-warc") {
    if (!options.target || !options.captureDir || !options.out) {
      return {
        ...options,
        error:
          "Usage: `rankproof export-warc run.json --capture-dir evidence/ --out evidence.warc.gz`.",
      };
    }
    return options;
  }
  if (options.command === "history") {
    if (!options.target) {
      return { ...options, error: "Usage: `rankproof history <dir>` (the --history directory)." };
    }
    if (options.format === "html" || options.format === "disavow") {
      return { ...options, error: "history supports --format text, json or csv." };
    }
    return options;
  }
  if (
    options.previous ||
    options.captureDir ||
    options.strict ||
    options.history ||
    options.webhook ||
    options.checkpoint ||
    options.render !== "off"
  ) {
    return {
      ...options,
      error:
        "--previous, --capture-dir, --strict, --history and --webhook apply to `verify` (and `replay`).",
    };
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
  if (options.format === "markdown") {
    return { ...options, error: "Format markdown is available for `verify` and `report`." };
  }
  if (options.command !== "scan" && (options.format === "html" || options.format === "disavow")) {
    return {
      ...options,
      error: `Format ${options.format} is only available for the \`scan\` command.`,
    };
  }
  return options;
}

export const HELP = `RankProof — verify backlinks with inspectable evidence; audit search visibility.

USAGE
  rankproof <command> <domain|file> [options]

COMMANDS
  verify <pairs.csv|->       Check known source→target links against their contract
                             (expected anchor / rel). Compare with --previous.
  replay <run.json>          Re-run extraction offline on HTML saved with --capture-dir.
  history <dir>              Per-link timeline from runs stored with verify --history.
  export-warc <run.json>     Package captured HTML + observations as a WARC 1.1 file
                             (--capture-dir and --out required).
  seal <file>                Seal evidence: SHA-256, optional Ed25519 signature (--key),
                             RFC 3161 timestamp (--tsa URL), Internet Archive copies (--wayback).
  check-seal <file>          Check a seal (and --public-key of the expected signer).
  keygen --out <name>        Create an Ed25519 signing key pair for seal
                             (refuses to overwrite one; --force to replace it).
  mcp                        Model Context Protocol server on stdio for AI agents
                             (tools: verify_links, explain_verdicts).
  report <run.json>          Re-format a stored verify run offline (text, csv, html, markdown).
  corpus <run.json>          Turn a captured run into a benchmark corpus to label by hand
                             (npm run benchmark -- --corpus cases.json scores it).
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
      --previous <run.json>  verify: report changes since an earlier run.
      --capture-dir <dir>    verify: save fetched HTML as evidence; replay: read it.
      --strict               verify: exit 3 unless every pair meets its contract.
      --history <dir>        verify: keep every run + HTML evidence in <dir> and
                             compare with the latest stored run automatically.
      --webhook <url>        verify: POST a summary when any link changed
                             (Slack/Discord-compatible "text"/"content" fields).
      --keep <n>             verify --history: run documents to keep (default 200).
      --checkpoint <file>    verify: save progress after every 50 pairs (JSONL) and
                             skip pairs already in it — rerun the same command to resume.
      --render[=always]      verify: re-check pages in headless Chromium when the HTML
                             has no link or is a JavaScript shell (always: every page,
                             which also detects links hidden with CSS). Needs the
                             optional playwright package and a Chromium.
                             replay: re-render the stored HTML offline.

PAIRS FILE (CSV, TSV or semicolons; header optional)
  source_url,target_url,expected_anchor,expected_rel,expected_placement
  https://publisher.example/post,https://you.example/guide,Your Brand,sponsored,content

EXAMPLES
  rankproof verify links.csv --format json --out run.json --capture-dir evidence/
  rankproof verify links.csv --previous run.json --format html --out report.html
  rankproof replay run.json --capture-dir evidence/
  rankproof verify links.csv --history monitor/ --webhook https://hooks.slack.com/…
  rankproof history monitor/ --format csv
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
