# Makefile for agents framework
# Generates Claude Code files from templates/

.PHONY: all cc validate clean build gen generate install

# Default: generate everything (currently CC only)
all: cc

# Generate CC files to generated/claude/
cc:
	@node scripts/generate.js cc --config defaults/config.json

# Validate committed files match templates (for CI)
validate:
	@node scripts/generate.js all --config defaults/config.json --dry-run

# Clean: since generated files are tracked, just regenerate
clean:
	@echo "Generated files are tracked in git."
	@echo "Run 'make all' to regenerate from templates."

# Aliases
build gen generate: all

# Install globally (runs its own silent generation with user config)
install:
	@npm install --silent
	@./install.sh
