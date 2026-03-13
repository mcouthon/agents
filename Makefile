# Makefile for agents framework
# Generates platform-specific files from templates/ into generated/

.PHONY: all copilot cc validate clean build gen generate install

# Default: generate everything
all: copilot cc

# Ensure dependencies are installed
node_modules: package.json
	npm install
	@touch node_modules

# Generate Copilot files to generated/copilot/
copilot: node_modules
	@node scripts/generate.js copilot --config defaults/config.yaml

# Generate CC files to generated/claude/
cc: node_modules
	@node scripts/generate.js cc --config defaults/config.yaml

# Validate committed files match templates (for CI)
validate: node_modules
	@node scripts/generate.js all --config defaults/config.yaml --dry-run

# Clean: since generated files are tracked, just regenerate
clean:
	@echo "Generated files are tracked in git."
	@echo "Run 'make all' to regenerate from templates."

# Aliases
build gen generate: all

# Install globally (runs its own silent generation with user config)
install: node_modules
	@./install.sh
