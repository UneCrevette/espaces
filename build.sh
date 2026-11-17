#!/bin/zsh
# Construit build/Espaces.app (aucune dépendance hors Xcode Command Line Tools).
set -euo pipefail
cd "$(dirname "$0")"
APP=build/Espaces.app

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -target "$(uname -m)-apple-macos12.0" \
  -o "$APP/Contents/MacOS/Espaces" native/main.swift native/peer.swift native/pdfexport.swift native/inktext.swift native/spell.swift native/voice.swift \
  -framework Cocoa -framework WebKit -framework PDFKit

if [[ ! -f build/AppIcon.icns ]]; then
  swiftc -O -o build/make-icon native/icon.swift -framework Cocoa
  build/make-icon build/AppIcon.iconset
  iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns
fi

cp native/Info.plist "$APP/Contents/Info.plist"
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp -R web "$APP/Contents/Resources/web"
codesign --force --deep --sign - "$APP"
echo "OK → $APP"
