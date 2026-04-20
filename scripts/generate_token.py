"""
단일 이메일에 대한 토큰을 확인/재생성하는 유틸.

Usage:
    python scripts/generate_token.py user@example.com [--secret SECRET]

Env:
    TOKEN_SECRET — .env 와 동일한 값 사용
"""
import argparse
import hashlib
import hmac
import os
import sys


def generate_token(email: str, secret: str) -> str:
    normalized = email.lower().strip()
    return hmac.new(
        secret.encode(), normalized.encode(), hashlib.sha256
    ).hexdigest()[:16]


def main():
    parser = argparse.ArgumentParser(description="Generate survey token for an email")
    parser.add_argument("email")
    parser.add_argument(
        "--secret",
        default=os.getenv("TOKEN_SECRET"),
        help="HMAC secret (default: $TOKEN_SECRET)",
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv("SURVEY_BASE_URL", "https://example.com/survey"),
    )
    args = parser.parse_args()

    if not args.secret:
        print("ERROR: TOKEN_SECRET not set (use --secret or env var)", file=sys.stderr)
        sys.exit(1)

    token = generate_token(args.email, args.secret)
    print(f"email: {args.email.lower().strip()}")
    print(f"token: {token}")
    print(f"link:  {args.base_url}?token={token}")


if __name__ == "__main__":
    main()
