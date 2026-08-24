/**
 * @codegraph/scm — the SCM miner and the `history.jsonl` interchange.
 *
 * Evolution facts are a third artifact beside `model.jsonl` (PLAN §11): this
 * package owns their vocabulary, wire format and file-level reports. It is
 * pure — the CLI owns the one `git log` subprocess and hands the bytes here.
 */

export {
  FIX_SUBJECT,
  HISTORY_SCHEMA_VERSION,
  REVERT_SUBJECT,
  type Change,
  type Commit,
  type History,
} from "./history.js";
export {
  HistoryChangeRec,
  HistoryCommitRec,
  HistoryEofRec,
  HistoryHeaderRec,
  HistoryPathRec,
  type HistoryRecord,
} from "./wire.js";
export {
  HistoryError,
  HistoryReader,
  decodeHistory,
  decodeHistoryText,
  encodeHistory,
  encodeHistoryToString,
} from "./jsonl.js";
export { GIT_PRETTY, GitLogParseError, gitLogArgs, parseGitLog, type MineMeta } from "./gitlog.js";
export {
  MOMENTUM_WINDOW_DAYS,
  authorStats,
  hotspots,
  summarize,
  type AuthorRow,
  type AuthorsReport,
  type HistorySummary,
  type HotspotRow,
} from "./reports.js";
