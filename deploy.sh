#!/bin/bash

# Hanks Tank Backend - GCP App Engine Deployment Script
set -e

echo "🚀 Starting deployment to Google Cloud App Engine..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}Error: gcloud CLI is not installed${NC}"
    echo "Please install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check if user is authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
    echo -e "${YELLOW}Warning: You are not authenticated with gcloud${NC}"
    echo "Run: gcloud auth login"
    exit 1
fi

# Set project (optional, can be overridden)
PROJECT_ID=${1:-"hankstank"}
echo -e "${BLUE}Using project: $PROJECT_ID${NC}"

# Set the project
gcloud config set project $PROJECT_ID

# Clean and build
echo -e "${YELLOW}🔧 Cleaning and building project...${NC}"
npm run clean
npm run build

# Check if build was successful
if [ ! -d "dist" ]; then
    echo -e "${RED}❌ Build failed - dist directory not found${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Build completed successfully${NC}"

# Deploy to App Engine
echo -e "${YELLOW}🚢 Deploying to App Engine...${NC}"
gcloud app deploy app.yaml --project=$PROJECT_ID --quiet

# Check deployment status
if [ $? -eq 0 ]; then
    echo -e "${GREEN}🎉 Deployment successful!${NC}"
    
    # Get the service URL
    SERVICE_URL=$(gcloud app browse -s hanks-tank-backend --project=$PROJECT_ID --no-launch-browser --format="value(url)" 2>/dev/null || echo "")
    
    if [ -n "$SERVICE_URL" ]; then
        echo -e "${BLUE}📍 Service URL: $SERVICE_URL${NC}"
        echo -e "${BLUE}🏥 Health Check: $SERVICE_URL/health${NC}"
        echo -e "${BLUE}📊 API Endpoints: $SERVICE_URL/api/legacy/teamBatting${NC}"
    fi
    
    echo -e "${YELLOW}📊 Monitor logs with: npm run gcp:logs${NC}"
    echo -e "${YELLOW}🌐 Open in browser: npm run gcp:browse${NC}"
else
    echo -e "${RED}❌ Deployment failed${NC}"
    exit 1
fi

echo -e "${GREEN}🚀 Deployment complete!${NC}"
