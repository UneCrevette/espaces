#!/bin/zsh
# Construit « Installeur Espaces.app » et le range dans ~/Applications (le Launchpad et Spotlight le trouvent).
set -euo pipefail
cd "$(dirname "$0")"
OUT=../../build/installeur
APP="$OUT/Installeur Espaces.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -parse-as-library -target "$(uname -m)-apple-macos13.0" -o "$APP/Contents/MacOS/Installeur" Installeur.swift

swiftc -O -o "$OUT/make-icon" icon.swift -framework Cocoa
"$OUT/make-icon" "$OUT/AppIcon.iconset"
iconutil -c icns "$OUT/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

cp Info.plist "$APP/Contents/Info.plist"
# l'Installeur retient le dossier du projet d'où il a été construit
/usr/libexec/PlistBuddy -c "Add :EspacesProject string $(cd ../.. && pwd)" "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"

mkdir -p ~/Applications
rm -rf ~/Applications/"Installeur Espaces.app"
cp -R "$APP" ~/Applications/
echo "OK → ~/Applications/Installeur Espaces.app"
