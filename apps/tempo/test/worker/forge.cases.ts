// The Git forge (09), project CI (10), public profile (11), app deploy (12) and Artifacts Worker cases load as one group; their hooks are
// shared within it.
import "./repositories.cases.ts";
import "./native-pull-requests.cases.ts";
import "./repository-issues.cases.ts";
import "./artifacts-preflight.cases.ts";
import "./artifacts-migration.cases.ts";
import "./artifacts-egress.cases.ts";
import "./project-ci.cases.ts";
import "./dotfiles.cases.ts";
import "./artifacts.cases.ts";
import "./artifacts-workspace.cases.ts";
import "./native-workspace-pull-requests.cases.ts";
import "./agent-issues.cases.ts";
import "./ci-runner.cases.ts";
import "./app-deploy.cases.ts";
import "./public-profile.cases.ts";
