import requests
import json
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

def fetch_mlb_top_headlines():
    api_key = os.getenv('NewsApiKey')  # Ensure this environment variable is set

    base_url = "https://newsapi.org/v2/everything"

    # Define your queries
    queries = ["MLB", "Atlanta Braves"]
    for query in queries:
        query_params = {
            "q": query,
            "sortBy": "popularity",
            "language": "en",
            "apiKey": api_key,
        }

        response = requests.get(base_url, params=query_params)

        if response.status_code == 200:
            filename = f'mlb_news_{query.replace(" ", "_").lower()}.json'
            with open(filename, 'w') as file:
                json.dump(response.json(), file)
        else:
            print(api_key)
            print("not successful")

    print("News data stored locally successfully!")

if __name__ == "__main__":
    fetch_mlb_top_headlines()
