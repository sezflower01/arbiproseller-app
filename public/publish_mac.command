
#!/bin/bash
echo "🚀 Publishing CloudArbi as .app for macOS..."
PROJECT_NAME="CloudArbi.csproj"
OUTPUT_PATH="$HOME/Desktop/CloudArbiApp"

dotnet publish "$PROJECT_NAME" \
 -c Release \
 -f net8.0-maccatalyst \
 -r maccatalyst-x64 \
 --self-contained true \
 -p:PublishSingleFile=true \
 -p:WindowsPackageType=None \
 -o "$OUTPUT_PATH"

echo "✅ Done! Your app is in: $OUTPUT_PATH"
