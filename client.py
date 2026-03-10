"""
URL Shortener Python Client
A lightweight client for the Cloudflare Workers URL Shortener API.

Setup:
    pip install requests
    export SHORTENER_API_KEY=your-api-key
    export SHORTENER_BASE_URL=https://yourdomain.com

Usage:
    from client import URLShortenerClient
    client = URLShortenerClient()
    short = client.create("https://example.com/very/long/url", campaign="blog_post")
    print(short)  # https://yourdomain.com/s/42

Full tutorial: https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/
"""

import os
import requests
from typing import Optional


class URLShortenerClient:
    """Client for the Cloudflare Workers URL Shortener API."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
    ):
        self.api_key = api_key or os.getenv("SHORTENER_API_KEY")
        self.base_url = (base_url or os.getenv("SHORTENER_BASE_URL", "")).rstrip("/")

        if not self.api_key:
            raise ValueError("API key required: set SHORTENER_API_KEY env var or pass api_key=")
        if not self.base_url:
            raise ValueError("Base URL required: set SHORTENER_BASE_URL env var or pass base_url=")

    @property
    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def create(
        self,
        long_url: str,
        code: Optional[str] = None,
        campaign: str = "general",
        notes: Optional[str] = None,
    ) -> Optional[str]:
        """
        Create a new short URL.

        Args:
            long_url: The full URL to shorten
            code: Optional custom short code (auto-generated if omitted)
            campaign: UTM campaign tag (default: "general")
            notes: Optional notes for admin reference

        Returns:
            The short URL string, or None on failure
        """
        payload = {"url": long_url, "campaign": campaign}
        if code:
            payload["code"] = code
        if notes:
            payload["notes"] = notes

        try:
            resp = requests.post(
                f"{self.base_url}/api/shorten",
                json=payload,
                headers=self._headers,
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json()["shortUrl"]
        except requests.HTTPError as e:
            print(f"HTTP error creating short URL: {e.response.status_code} {e.response.text}")
        except Exception as e:
            print(f"Error creating short URL: {e}")
        return None

    def list_urls(self) -> list[dict]:
        """Return all active (non-deleted) short URLs with stats."""
        try:
            resp = requests.get(
                f"{self.base_url}/api/urls",
                headers=self._headers,
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json().get("urls", [])
        except Exception as e:
            print(f"Error listing URLs: {e}")
        return []

    def get_stats(self, code: str) -> Optional[dict]:
        """Return click statistics for a short code."""
        try:
            resp = requests.get(
                f"{self.base_url}/api/stats/{code}",
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print(f"Error getting stats for {code}: {e}")
        return None

    def update(
        self,
        code: str,
        url: Optional[str] = None,
        campaign: Optional[str] = None,
        new_code: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> Optional[dict]:
        """Update an existing short URL's properties."""
        payload = {}
        if url:
            payload["url"] = url
        if campaign is not None:
            payload["campaign"] = campaign
        if new_code:
            payload["code"] = new_code
        if notes is not None:
            payload["notes"] = notes

        try:
            resp = requests.put(
                f"{self.base_url}/api/urls/{code}",
                json=payload,
                headers=self._headers,
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print(f"Error updating {code}: {e}")
        return None

    def delete(self, code: str) -> bool:
        """Soft-delete a short URL (can be restored later)."""
        try:
            resp = requests.delete(
                f"{self.base_url}/api/urls/{code}",
                headers=self._headers,
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json().get("deleted", False)
        except Exception as e:
            print(f"Error deleting {code}: {e}")
        return False

    def restore(self, code: str) -> bool:
        """Restore a soft-deleted short URL."""
        try:
            resp = requests.post(
                f"{self.base_url}/api/urls/{code}/restore",
                headers=self._headers,
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json().get("restored", False)
        except Exception as e:
            print(f"Error restoring {code}: {e}")
        return False


def shorten_for_social(long_url: str, campaign: str = "social") -> str:
    """
    Convenience wrapper: shorten a URL for social media posting.
    Falls back to the original URL with a simple UTM tag on failure.

    Example:
        url = shorten_for_social("https://example.com/very/long/post/", "twitter")
        # Returns: https://yourdomain.com/s/42  (or fallback)
    """
    try:
        client = URLShortenerClient()
        short = client.create(long_url, campaign=campaign)
        if short:
            return short
    except Exception:
        pass
    return f"{long_url}?utm_source={campaign}"


if __name__ == "__main__":
    # Quick demo
    import json

    client = URLShortenerClient()

    print("Creating a test short URL...")
    short_url = client.create(
        "https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/",
        campaign="demo",
        notes="README demo",
    )
    print(f"Short URL: {short_url}")

    if short_url:
        code = short_url.split("/s/")[-1]
        print(f"\nStats for '{code}':")
        print(json.dumps(client.get_stats(code), indent=2))

    print("\nAll active URLs:")
    for u in client.list_urls():
        print(f"  /s/{u['code']} → {u['url']} ({u['stats'].get('total', 0)} clicks)")
