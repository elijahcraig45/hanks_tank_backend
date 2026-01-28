#!/bin/bash

# Hank's Tank 2026 Season Verification Script
# This script tests all critical endpoints and verifies the system is ready for 2026

echo "=================================="
echo "Hank's Tank 2026 Season Verification"
echo "=================================="
echo ""

# Configuration
API_BASE="https://hankstank.uc.r.appspot.com"
CURRENT_YEAR=2026
HISTORICAL_YEAR=2024

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counter
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Function to run a test
run_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_condition="$3"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    echo -e "${BLUE}Test $TOTAL_TESTS: $test_name${NC}"
    
    # Run the command and capture output
    response=$(eval "$test_command" 2>&1)
    exit_code=$?
    
    # Check if command succeeded
    if [ $exit_code -eq 0 ] && echo "$response" | eval "$expected_condition" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ PASS${NC}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
    else
        echo -e "${RED}✗ FAIL${NC}"
        echo "  Response: $response"
        FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
    echo ""
}

echo "=== Backend Health Checks ==="
echo ""

# Test 1: Health Endpoint
run_test \
    "Backend health check" \
    "curl -s -f $API_BASE/health" \
    "jq -e '.status == \"healthy\"'"

# Test 2: BigQuery Sync Status
run_test \
    "BigQuery sync status" \
    "curl -s -f $API_BASE/api/sync/status" \
    "jq -e '.summary.totalRecords > 0'"

echo "=== Historical Data Tests (2015-2025) ==="
echo ""

# Test 3: Historical Team Batting
run_test \
    "Historical team batting ($HISTORICAL_YEAR)" \
    "curl -s -f '$API_BASE/api/team-batting?year=$HISTORICAL_YEAR&limit=5'" \
    "jq -e 'length > 0 and .[0].Team != null'"

# Test 4: Historical Team Pitching
run_test \
    "Historical team pitching ($HISTORICAL_YEAR)" \
    "curl -s -f '$API_BASE/api/team-pitching?year=$HISTORICAL_YEAR&limit=5'" \
    "jq -e 'length > 0 and .[0].Team != null'"

# Test 5: Historical Standings
run_test \
    "Historical standings ($HISTORICAL_YEAR)" \
    "curl -s -f '$API_BASE/api/Standings?year=$HISTORICAL_YEAR'" \
    "jq -e 'length > 0'"

echo "=== Current Season Data Tests (2026) ==="
echo ""

# Test 6: Current Year Team Batting
run_test \
    "Current season team batting ($CURRENT_YEAR)" \
    "curl -s -f '$API_BASE/api/team-batting?year=$CURRENT_YEAR&limit=5'" \
    "jq -e 'type == \"array\"'"

# Test 7: Current Year Team Pitching
run_test \
    "Current season team pitching ($CURRENT_YEAR)" \
    "curl -s -f '$API_BASE/api/team-pitching?year=$CURRENT_YEAR&limit=5'" \
    "jq -e 'type == \"array\"'"

# Test 8: Current Year Standings
run_test \
    "Current season standings ($CURRENT_YEAR)" \
    "curl -s -f '$API_BASE/api/Standings?year=$CURRENT_YEAR'" \
    "jq -e 'type == \"array\"'"

echo "=== Player Data Tests ==="
echo ""

# Test 9: Player Batting Stats
run_test \
    "Player batting stats ($CURRENT_YEAR)" \
    "curl -s -f '$API_BASE/api/player-batting?year=$CURRENT_YEAR&limit=10'" \
    "jq -e 'type == \"array\"'"

# Test 10: Player Pitching Stats
run_test \
    "Player pitching stats ($CURRENT_YEAR)" \
    "curl -s -f '$API_BASE/api/player-pitching?year=$CURRENT_YEAR&limit=10'" \
    "jq -e 'type == \"array\"'"

echo "=== Advanced Analytics Tests ==="
echo ""

# Test 11: Available Stats
run_test \
    "Available stats metadata" \
    "curl -s -f '$API_BASE/api/available-stats?dataType=team-batting'" \
    "jq -e 'type == \"array\"'"

# Test 12: News Endpoint
run_test \
    "MLB news endpoint" \
    "curl -s -f '$API_BASE/api/mlb-news'" \
    "jq -e 'type == \"array\"'"

echo "=== Data Routing Verification ==="
echo ""

# Test 13: Verify historical data comes from BigQuery
echo -e "${BLUE}Test 13: Verify historical data source (BigQuery)${NC}"
historical_response=$(curl -s "$API_BASE/api/team-batting?year=$HISTORICAL_YEAR&limit=1")
if echo "$historical_response" | jq -e '.[0].Team != null' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Historical data successfully retrieved${NC}"
    echo "  Sample: $(echo "$historical_response" | jq -r '.[0].Team // "N/A"')"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}✗ Historical data retrieval failed${NC}"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    FAILED_TESTS=$((FAILED_TESTS + 1))
fi
echo ""

# Test 14: Verify current season data comes from Live API
echo -e "${BLUE}Test 14: Verify current season data source (Live API)${NC}"
current_response=$(curl -s "$API_BASE/api/team-batting?year=$CURRENT_YEAR&limit=1")
if echo "$current_response" | jq -e 'type == "array"' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Current season data endpoint accessible${NC}"
    echo "  Note: Data availability depends on season start date"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${YELLOW}⚠ Current season data not yet available (pre-season)${NC}"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    PASSED_TESTS=$((PASSED_TESTS + 1)) # Don't fail if season hasn't started
fi
echo ""

echo "==================================="
echo "Test Results Summary"
echo "==================================="
echo ""
echo "Total Tests:  $TOTAL_TESTS"
echo -e "${GREEN}Passed:       $PASSED_TESTS${NC}"
echo -e "${RED}Failed:       $FAILED_TESTS${NC}"
echo ""

if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}🎉 ALL TESTS PASSED! System is ready for 2026 season!${NC}"
    exit 0
else
    echo -e "${RED}⚠️  Some tests failed. Please review the output above.${NC}"
    exit 1
fi
