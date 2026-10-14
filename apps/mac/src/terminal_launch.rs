//! Launch the bundled bridge in a local terminal. Credentials are read by the bridge from Keychain.
#[cfg(target_os = "macos")]
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalApplication {
    Terminal,
    ITerm,
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn applescript_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn bridge_path(app: &Path) -> Result<PathBuf, &'static str> {
    app.parent()
        .map(|dir| dir.join("tempo"))
        .ok_or("Could not find the bundled tempo command.")
}

pub fn launch_script(
    app: TerminalApplication,
    executable: &Path,
    workspace: &str,
    terminal: &str,
) -> Result<String, &'static str> {
    if crate::url_scheme::workspace_id(&format!("tempo://workspace/{workspace}")).is_none() {
        return Err("Use a valid workspace ID.");
    }
    if !tempo_client::TERMINAL_IDS.contains(&terminal) {
        return Err("Choose a terminal from t1 to t9.");
    }
    let path = executable
        .to_str()
        .ok_or("Could not read the tempo command path.")?;
    if path.chars().any(char::is_control) {
        return Err("Could not read the tempo command path.");
    }
    let command = applescript_quote(&format!(
        "exec {} terminal {} {}",
        shell_quote(path),
        shell_quote(workspace),
        shell_quote(terminal)
    ));
    Ok(match app {
        TerminalApplication::Terminal => {
            format!("tell application \"Terminal\"\nactivate\ndo script {command}\nend tell\n")
        }
        TerminalApplication::ITerm => format!(
            "tell application \"iTerm\"\nactivate\ncreate window with default profile\ntell current session of current window\nwrite text {command}\nend tell\nend tell\n"
        ),
    })
}

pub fn open(app: TerminalApplication, workspace: &str, terminal: &str) -> Result<(), &'static str> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, workspace, terminal);
        Err("Opening a local terminal is available on macOS.")
    }
    #[cfg(target_os = "macos")]
    {
        let executable = std::env::current_exe().map_err(|_| "Could not find Tempo for Mac.")?;
        let helper = bridge_path(&executable)?;
        if !helper.is_file() {
            return Err(
                "The bundled tempo command is missing. Build both Mac binaries or reinstall Tempo.",
            );
        }
        let script = launch_script(app, &helper, workspace, terminal)?;
        execute_script(&script)
    }
}

#[cfg(target_os = "macos")]
fn execute_script(script: &str) -> Result<(), &'static str> {
    let mut child = Command::new("/usr/bin/osascript")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not open the local terminal.")?;
    let written = child
        .stdin
        .take()
        .ok_or("Could not open the local terminal.")?
        .write_all(script.as_bytes());
    let status = child
        .wait()
        .map_err(|_| "Could not open the local terminal.")?;
    if written.is_err() || !status.success() {
        return Err(
            "Could not open the local terminal. Check that it is installed and allow Tempo to control it in System Settings.",
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locates_the_helper_next_to_the_app_binary() {
        assert_eq!(
            bridge_path(Path::new("/Applications/Tempo.app/Contents/MacOS/Tempo")).unwrap(),
            Path::new("/Applications/Tempo.app/Contents/MacOS/tempo")
        );
    }
    #[test]
    fn launch_commands_preserve_shell_metacharacters_as_literal_paths() {
        let path =
            Path::new("/Applications/Tempo 'quoted' $(touch BAD) `cmd`.app/Contents/MacOS/tempo");
        let script =
            launch_script(TerminalApplication::Terminal, path, "workspace1", "t2").unwrap();
        assert!(script.contains("do script \"exec '/Applications/Tempo "));
        assert!(script.contains("$(touch BAD) `cmd`"));
        assert!(script.contains("'workspace1' 't2'"));
        assert!(script.contains("'\\\\''quoted'\\\\''"));
        assert!(!script.contains("Bearer"));
        assert!(launch_script(TerminalApplication::Terminal, path, "x;ls", "t1").is_err());
        assert!(launch_script(TerminalApplication::Terminal, path, "id", "t10").is_err());
    }
    #[test]
    fn iterm_opens_the_default_profile_and_writes_the_bridge_command() {
        let script = launch_script(
            TerminalApplication::ITerm,
            Path::new("/tmp/tempo"),
            "id",
            "t9",
        )
        .unwrap();
        assert!(script.contains("tell application \"iTerm\""));
        assert!(script.contains("create window with default profile"));
        assert!(script.contains("write text \"exec '/tmp/tempo' terminal 'id' 't9'\""));
    }
}
