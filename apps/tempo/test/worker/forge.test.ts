// The Git forge (09), project CI (10) and organization (11) Worker cases share one test file, so they pay the
// per-file workerd startup once (docs/CI.md). Each module keeps its own scope and hooks.
import "./repositories.cases.ts";
import "./native-pull-requests.cases.ts";
import "./repository-issues.cases.ts";
import "./artifacts-preflight.cases.ts";
import "./artifacts-migration.cases.ts";
import "./artifacts-egress.cases.ts";
import "./project-ci.cases.ts";
import "./organizations.cases.ts";
