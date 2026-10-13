#[cfg(target_os = "macos")]
mod mac {
    use security_framework::os::macos::code_signing::{
        Flags, GuestAttributes, SecCode, SecRequirement,
    };
    use security_framework::passwords::{
        PasswordOptions, delete_generic_password, generic_password, set_generic_password,
    };
    use std::{
        io::{Read, Write},
        process::Command,
    };
    const SERVICE: &str = "dev.tempo.mac";
    const HELPER: &str = "identifier \"dev.tempo.mac.keychain\"";
    unsafe extern "C" {
        fn getppid() -> i32;
    }

    fn parent_requirement(text: &str) -> Option<String> {
        let own = text
            .lines()
            .find_map(|line| line.strip_prefix("designated => "))?;
        if !own.starts_with(HELPER) || !own.contains("certificate leaf") {
            return None;
        }
        Some(own.replacen(HELPER, "identifier \"dev.tempo.mac\"", 1))
    }

    fn authorize() -> Result<(), i32> {
        let path = std::env::current_exe().map_err(|_| -50)?;
        let signature = Command::new("/usr/bin/codesign")
            .args(["-d", "-r-"])
            .arg(path)
            .output()
            .map_err(|_| -50)?;
        if !signature.status.success() {
            return Err(-67050);
        }
        let requirement =
            parent_requirement(&String::from_utf8_lossy(&signature.stdout)).ok_or(-67050)?;
        let requirement: SecRequirement = requirement
            .parse()
            .map_err(|e: security_framework::base::Error| e.code())?;
        let mut attributes = GuestAttributes::new();
        attributes.set_pid(unsafe { getppid() });
        let parent = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE)
            .map_err(|e| e.code())?;
        parent
            .check_validity(Flags::NONE, &requirement)
            .map_err(|e| e.code())
    }

    pub fn run() -> Result<(), i32> {
        authorize()?;
        let mut args = std::env::args().skip(1);
        let operation = args.next().ok_or(-50)?;
        let account = args
            .next()
            .filter(|a| !a.is_empty() && a.len() <= 255 && !a.chars().any(char::is_control))
            .ok_or(-50)?;
        if args.next().is_some() {
            return Err(-50);
        }
        match operation.as_str() {
            "get" => {
                let mut secret =
                    generic_password(PasswordOptions::new_generic_password(SERVICE, &account))
                        .map_err(|e| e.code())?;
                let result = std::io::stdout().write_all(&secret).map_err(|_| -36);
                secret.fill(0);
                result
            }
            "set" => {
                let mut secret = Vec::new();
                std::io::stdin()
                    .take(65_537)
                    .read_to_end(&mut secret)
                    .map_err(|_| -36)?;
                if secret.is_empty() || secret.len() > 65_536 {
                    secret.fill(0);
                    return Err(-50);
                }
                let result = set_generic_password(SERVICE, &account, &secret).map_err(|e| e.code());
                secret.fill(0);
                result
            }
            "delete" => delete_generic_password(SERVICE, &account).map_err(|e| e.code()),
            _ => Err(-50),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn caller_rule_keeps_the_signer_and_only_changes_the_identifier() {
            let rule = "designated => identifier \"dev.tempo.mac.keychain\" and certificate leaf = H\"abc\"\n";
            assert_eq!(
                parent_requirement(rule).as_deref(),
                Some("identifier \"dev.tempo.mac\" and certificate leaf = H\"abc\"")
            );
            assert!(
                parent_requirement(
                    "designated => identifier \"other\" and certificate leaf = H\"abc\""
                )
                .is_none()
            );
            assert!(
                parent_requirement(
                    "designated => identifier \"dev.tempo.mac.keychain\" and cdhash H\"abc\""
                )
                .is_none()
            );
        }
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    if let Err(status) = mac::run() {
        eprintln!("Keychain status={status}");
        std::process::exit(1);
    }
    #[cfg(not(target_os = "macos"))]
    std::process::exit(1);
}
