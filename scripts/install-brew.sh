#!/bin/bash

# Homebrew Bootstrap Script
# Installs Homebrew via the official installer, then OpenConnect on top of it.
# The app opens this in Terminal only when brew is missing, since brew's own
# installer needs an interactive Terminal for its sudo password prompt.

set -e

echo "=========================================="
echo "Homebrew + OpenConnect Installation Helper"
echo "=========================================="
echo ""

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ This script is designed for macOS only"
    exit 1
fi

# Install Homebrew if it is missing
if ! command -v brew &> /dev/null; then
    echo "⏳ Installing Homebrew (will ask for your password)..."
    echo ""
    # NONINTERACTIVE skips the "press RETURN to continue" pause so the window
    # the app opened runs start to finish; sudo still prompts for a password
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    echo ""
else
    echo "✅ Homebrew is installed"
    echo ""
fi

# A just-installed brew is not on this shell's PATH yet
if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
fi

if ! command -v brew &> /dev/null; then
    echo "❌ Homebrew installation did not complete"
    exit 1
fi

# Check if OpenConnect is already installed
if command -v openconnect &> /dev/null; then
    VERSION=$(openconnect --version | head -n1)
    echo "✅ OpenConnect is already installed"
    echo "   $VERSION"
else
    echo "⏳ Installing OpenConnect via Homebrew..."
    echo ""

    # set -e above already exits if brew fails, so no $? check here
    brew install openconnect

    echo ""
    echo "✅ OpenConnect installed successfully!"
    VERSION=$(openconnect --version | head -n1)
    echo "   $VERSION"
fi

echo ""
echo "=========================================="
echo "Installation complete!"
echo "=========================================="
echo ""
echo "You can now use the OpenConnect VPN GUI application."
echo ""
