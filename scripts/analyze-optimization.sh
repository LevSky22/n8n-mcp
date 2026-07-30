#!/bin/bash
# Analyze potential optimization savings

echo "🔍 Analyzing Docker Optimization Potential"
echo "=========================================="

# Check current database size
if [ -f data/nodes.db ]; then
    DB_SIZE=$(du -h data/nodes.db | cut -f1)
    echo "Current database size: $DB_SIZE"
fi

# Check node_modules size
if [ -d node_modules ]; then
    echo -e "\n📦 Package sizes:"
    echo "Total node_modules: $(du -sh node_modules | cut -f1)"
    echo "n8n packages:"
    for pkg in n8n n8n-core n8n-workflow @n8n/n8n-nodes-langchain; do
        if [ -d "node_modules/$pkg" ]; then
            SIZE=$(du -sh "node_modules/$pkg" 2>/dev/null | cut -f1 || echo "N/A")
            echo "  - $pkg: $SIZE"
        fi
    done
fi

# Check runtime dependencies
echo -e "\n🎯 Runtime-only dependencies:"
RUNTIME_DEPS="@modelcontextprotocol/sdk @modelcontextprotocol/server @modelcontextprotocol/node better-sqlite3 sql.js express dotenv"
RUNTIME_SIZE=0
for dep in $RUNTIME_DEPS; do
    if [ -d "node_modules/$dep" ]; then
        SIZE=$(du -sh "node_modules/$dep" 2>/dev/null | cut -f1 || echo "0")
        echo "  - $dep: $SIZE"
    fi
done

# Estimate savings
echo -e "\n💡 Optimization potential:"
echo "- Current image: 2.61GB"
echo "- Estimated optimized: ~200MB"
echo "- Savings: ~92%"

# Show what would be removed
echo -e "\n🗑️  Would remove in optimization:"
echo "- n8n packages (>2GB)"
echo "- Build dependencies"
echo "- Documentation files"
echo "- Test files"
echo "- Source maps"

# Check if optimized database exists
if [ -f data/nodes-optimized.db ]; then
    OPT_SIZE=$(du -h data/nodes-optimized.db | cut -f1)
    echo -e "\n✅ Optimized database exists: $OPT_SIZE"
fi
