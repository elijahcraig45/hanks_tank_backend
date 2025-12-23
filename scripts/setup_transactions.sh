#!/bin/bash

# MLB Transactions Setup Script
# This script sets up the complete transactions system

set -e

echo "🏀 MLB Transactions Setup Script"
echo "================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}ℹ $1${NC}"
}

# Check if we're in the backend directory
if [ ! -f "package.json" ]; then
    print_error "Must be run from hanks_tank_backend directory"
    exit 1
fi

print_info "Step 1: Installing dependencies..."
if npm list typescript > /dev/null 2>&1; then
    print_success "Dependencies already installed"
else
    npm install
    print_success "Dependencies installed"
fi

print_info "Step 2: Compiling TypeScript..."
if npm run build; then
    print_success "TypeScript compiled successfully"
else
    print_error "TypeScript compilation failed"
    exit 1
fi

print_info "Step 3: Creating BigQuery table..."
echo ""
echo "Please run this SQL in your BigQuery console:"
echo "-------------------------------------------"
cat scripts/bigquery/transactions_schema.sql
echo "-------------------------------------------"
echo ""
read -p "Press Enter once you've created the BigQuery table..."
print_success "BigQuery table created"

print_info "Step 4: Would you like to collect historical data now?"
echo "This will fetch transactions from 2015-2025 (may take 15-20 minutes)"
read -p "Collect historical data? (y/n): " collect_data

if [[ $collect_data =~ ^[Yy]$ ]]; then
    print_info "Collecting historical transactions data..."
    node scripts/collect_historical_transactions.js
    print_success "Historical data collection complete"
else
    print_info "Skipping historical data collection"
    echo "You can run it later with: node scripts/collect_historical_transactions.js"
fi

print_info "Step 5: Testing API endpoints..."
if npm run dev > /dev/null 2>&1 & 
then
    SERVER_PID=$!
    sleep 5
    
    # Test health endpoint
    if curl -s http://localhost:8080/health | grep -q "healthy"; then
        print_success "Backend server is running"
        
        # Test transactions endpoint
        if curl -s http://localhost:8080/api/transactions/recent | grep -q "success"; then
            print_success "Transactions API is working"
        else
            print_error "Transactions API test failed"
        fi
    else
        print_error "Backend server health check failed"
    fi
    
    # Kill test server
    kill $SERVER_PID 2>/dev/null
else
    print_error "Failed to start backend server"
fi

echo ""
echo "================================="
print_success "Setup Complete! 🎉"
echo "================================="
echo ""
echo "Next steps:"
echo "1. Start the backend: npm run dev"
echo "2. Navigate to hanks_tank frontend directory"
echo "3. Add transactions routes to your App.js"
echo "4. Start the frontend: npm start"
echo ""
echo "API Endpoints:"
echo "  - GET /api/transactions/recent"
echo "  - GET /api/transactions/team/:teamId"
echo "  - GET /api/transactions/year/:year"
echo ""
echo "Frontend Components:"
echo "  - Transactions.js (all transactions view)"
echo "  - TeamTransactions.js (team-specific view)"
echo ""
echo "Documentation: See TRANSACTIONS_README.md for full details"
echo ""
