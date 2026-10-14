fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match tempo_mac::terminal_cli::run(&args) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("tempo: {message}");
            std::process::ExitCode::FAILURE
        }
    }
}
