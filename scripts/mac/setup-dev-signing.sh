#!/usr/bin/env bash
set -euo pipefail
[[ $(uname -s) == Darwin ]] || { echo 'Run on macOS.' >&2; exit 1; }
identity='Tempo Development'
if security find-identity -v -p codesigning | python3 -c 'import sys; sys.exit(0 if "\"Tempo Development\"" in sys.stdin.read() else 1)'; then
  echo 'Tempo Development is already installed.'
  exit 0
fi
umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/certificate.conf" <<'CONFIG'
[req]
distinguished_name = subject
x509_extensions = signing
prompt = no
[subject]
CN = Tempo Development
[signing]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CONFIG
openssl req -new -newkey rsa:3072 -x509 -sha256 -nodes -days 3650 -config "$work/certificate.conf" -keyout "$work/key.pem" -out "$work/certificate.pem" 2>/dev/null
import_password=$(openssl rand -hex 24)
export TEMPO_DEV_IMPORT_PASSWORD="$import_password"
/usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/certificate.pem" -name "$identity" -out "$work/identity.p12" -passout env:TEMPO_DEV_IMPORT_PASSWORD
keychain=$(security default-keychain -d user | python3 -c 'import sys; print(sys.stdin.read().strip().strip("\""))')
security import "$work/identity.p12" -k "$keychain" -P "$import_password" -T /usr/bin/codesign
unset import_password TEMPO_DEV_IMPORT_PASSWORD
security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$work/certificate.pem"
security find-identity -v -p codesigning | python3 -c 'import sys; sys.exit(0 if "\"Tempo Development\"" in sys.stdin.read() else 1)'
echo 'Tempo Development is installed. Run bun run mac:dev.'
