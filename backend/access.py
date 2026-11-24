import re

import jwt

from .settings import Settings

CF_HEADER = "cf-access-jwt-assertion"
_LOCAL_ORIGIN = re.compile(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$")


class AccessVerifier:
    """Validates Cloudflare Access JWTs: RS256 signature (team JWKS, cached), aud, exp, iss.
    `identify` returns the email; who may do what is decided in roles.py (owner = `email`)."""

    def __init__(self, team: str, aud: str, email: str):
        self.issuer = f"https://{team}.cloudflareaccess.com"
        self.aud = aud
        self.email = email.lower()
        self.jwks = jwt.PyJWKClient(f"{self.issuer}/cdn-cgi/access/certs",
                                    cache_keys=True, lifespan=3600)

    def identify(self, token: str | None) -> str | None:
        """The (lower-cased) email of a valid Access token, else None."""
        if not token:
            return None
        try:
            key = self.jwks.get_signing_key_from_jwt(token).key
            claims = jwt.decode(token, key, algorithms=["RS256"], audience=self.aud,
                                issuer=self.issuer, options={"require": ["exp", "aud", "iss"]})
        except Exception:  # bad format, signature, claims, JWKS fetch failure: all deny
            return None
        return str(claims.get("email", "")).strip().lower() or None

    def verify(self, token: str | None) -> bool:
        """True only for the owner."""
        return self.identify(token) == self.email


def make_verifier(settings: Settings) -> AccessVerifier | None:
    if not settings.require_access_header:
        return None
    if not (settings.access_team and settings.access_aud and settings.access_email):
        raise ValueError("RP_REQUIRE_ACCESS=1 needs RP_ACCESS_TEAM, RP_ACCESS_AUD, RP_ACCESS_EMAIL")
    return AccessVerifier(settings.access_team, settings.access_aud, settings.access_email)


def origin_allowed(settings: Settings, origin: str | None) -> bool:
    if origin is None:  # non-browser client; still subject to the JWT check
        return True
    if origin == settings.allowed_origin:
        return True
    return not settings.require_access_header and bool(_LOCAL_ORIGIN.match(origin))
