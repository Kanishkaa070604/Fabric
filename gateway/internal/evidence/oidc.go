package evidence

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// OIDCVerifier verifies Kubernetes SA JWTs (RS256) against a JWKS URI.
type OIDCVerifier struct {
	HTTPClient *http.Client
	mu         sync.Mutex
	cache      map[string]*jwksCache // key = jwks_uri
}

type jwksCache struct {
	fetchedAt time.Time
	keys      map[string]*rsa.PublicKey // kid -> key
}

func NewOIDCVerifier() *OIDCVerifier {
	return &OIDCVerifier{
		HTTPClient: &http.Client{Timeout: 5 * time.Second},
		cache:      make(map[string]*jwksCache),
	}
}

type jwtHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	Typ string `json:"typ"`
}

type jwtClaims struct {
	Iss string     `json:"iss"`
	Sub string     `json:"sub"`
	Aud flexString `json:"aud"`
	Exp int64      `json:"exp"`
	Nbf int64      `json:"nbf"`
	Iat int64      `json:"iat"`
}

// flexString accepts aud as string or []string.
type flexString []string

func (f *flexString) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = []string{s}
		return nil
	}
	var arr []string
	if err := json.Unmarshal(b, &arr); err != nil {
		return err
	}
	*f = arr
	return nil
}

type jwksDoc struct {
	Keys []jwkKey `json:"keys"`
}

type jwkKey struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func (v *OIDCVerifier) Verify(ctx context.Context, trust Trust, raw []byte) (*Attribution, error) {
	token := strings.TrimSpace(string(raw))
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("jwt_malformed")
	}
	hdrJSON, err := b64JSON(parts[0])
	if err != nil {
		return nil, fmt.Errorf("jwt_header: %w", err)
	}
	var hdr jwtHeader
	if err := json.Unmarshal(hdrJSON, &hdr); err != nil {
		return nil, fmt.Errorf("jwt_header_json: %w", err)
	}
	allowed := trust.AllowedAlgs
	if len(allowed) == 0 {
		allowed = []string{"RS256"}
	}
	algOK := false
	for _, a := range allowed {
		if hdr.Alg == a {
			algOK = true
			break
		}
	}
	if !algOK {
		return nil, fmt.Errorf("alg_not_allowed: %s", hdr.Alg)
	}
	// Pin algorithm from config — never trust alg:none / unexpected algs.
	if hdr.Alg != "RS256" {
		return nil, fmt.Errorf("alg_unsupported: %s", hdr.Alg)
	}

	claimsJSON, err := b64JSON(parts[1])
	if err != nil {
		return nil, fmt.Errorf("jwt_payload: %w", err)
	}
	var claims jwtClaims
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		return nil, fmt.Errorf("jwt_claims: %w", err)
	}
	iss := strings.TrimRight(trust.IssuerURL, "/")
	gotIss := strings.TrimRight(claims.Iss, "/")
	if gotIss != iss {
		return nil, fmt.Errorf("iss_mismatch")
	}
	audWant := trust.Audience
	if audWant == "" {
		audWant = "abluva-connect"
	}
	audOK := false
	for _, a := range claims.Aud {
		if a == audWant {
			audOK = true
			break
		}
	}
	if !audOK {
		return nil, fmt.Errorf("aud_mismatch")
	}
	now := time.Now().Unix()
	if claims.Exp > 0 && now > claims.Exp+30 {
		return nil, fmt.Errorf("token_expired")
	}
	if claims.Nbf > 0 && now+30 < claims.Nbf {
		return nil, fmt.Errorf("token_not_yet_valid")
	}

	pub, err := v.keyFor(ctx, trust.JWKSURI, hdr.Kid, trust.CABundlePEM)
	if err != nil {
		return nil, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, fmt.Errorf("jwt_sig: %w", err)
	}
	signed := []byte(parts[0] + "." + parts[1])
	sum := sha256.Sum256(signed)
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return nil, fmt.Errorf("sig_invalid: %w", err)
	}

	extra := map[string]string{}
	if strings.HasPrefix(claims.Sub, "system:serviceaccount:") {
		sp := strings.Split(claims.Sub, ":")
		if len(sp) >= 4 {
			extra["namespace"] = sp[2]
			extra["service_account"] = sp[3]
		}
	}
	return &Attribution{
		Strategy: "kubernetes_oidc",
		Subject:  claims.Sub,
		Issuer:   claims.Iss,
		Audience: audWant,
		Extra:    extra,
	}, nil
}

func (v *OIDCVerifier) keyFor(ctx context.Context, jwksURI, kid, caBundlePEM string) (*rsa.PublicKey, error) {
	keys, err := v.loadJWKS(ctx, jwksURI, caBundlePEM)
	if err != nil {
		return nil, err
	}
	if kid != "" {
		if k, ok := keys[kid]; ok {
			return k, nil
		}
		v.invalidate(jwksURI)
		keys, err = v.loadJWKS(ctx, jwksURI, caBundlePEM)
		if err != nil {
			return nil, err
		}
		if k, ok := keys[kid]; ok {
			return k, nil
		}
		return nil, fmt.Errorf("kid_not_found: %s", kid)
	}
	if len(keys) == 1 {
		for _, k := range keys {
			return k, nil
		}
	}
	return nil, fmt.Errorf("kid_required")
}

func (v *OIDCVerifier) invalidate(jwksURI string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.cache, jwksURI)
}

func (v *OIDCVerifier) loadJWKS(ctx context.Context, jwksURI, caBundlePEM string) (map[string]*rsa.PublicKey, error) {
	v.mu.Lock()
	if c, ok := v.cache[jwksURI]; ok && time.Since(c.fetchedAt) < 10*time.Minute {
		out := c.keys
		v.mu.Unlock()
		return out, nil
	}
	v.mu.Unlock()

	// Use the tenant's custom CA bundle for JWKS fetch if provided (common
	// for on-prem K8s clusters with self-signed OIDC issuer certs).
	client := v.HTTPClient
	if caBundlePEM != "" {
		pool := x509.NewCertPool()
		if pool.AppendCertsFromPEM([]byte(caBundlePEM)) {
			client = &http.Client{
				Timeout: 5 * time.Second,
				Transport: &http.Transport{
					TLSClientConfig: &tls.Config{RootCAs: pool},
				},
			}
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, jwksURI, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("jwks_fetch: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks_http_%d", res.StatusCode)
	}
	var doc jwksDoc
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		return nil, fmt.Errorf("jwks_json: %w", err)
	}
	keys := make(map[string]*rsa.PublicKey)
	for _, k := range doc.Keys {
		if k.Kty != "RSA" {
			continue
		}
		pub, err := rsaPublicFromJWK(k.N, k.E)
		if err != nil {
			continue
		}
		kid := k.Kid
		if kid == "" {
			kid = fmt.Sprintf("nokid-%d", len(keys))
		}
		keys[kid] = pub
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("jwks_empty")
	}
	v.mu.Lock()
	v.cache[jwksURI] = &jwksCache{fetchedAt: time.Now(), keys: keys}
	v.mu.Unlock()
	return keys, nil
}

func rsaPublicFromJWK(nB64, eB64 string) (*rsa.PublicKey, error) {
	nb, err := base64.RawURLEncoding.DecodeString(nB64)
	if err != nil {
		return nil, err
	}
	eb, err := base64.RawURLEncoding.DecodeString(eB64)
	if err != nil {
		return nil, err
	}
	n := new(big.Int).SetBytes(nb)
	var eInt int
	for _, b := range eb {
		eInt = eInt<<8 + int(b)
	}
	if eInt == 0 {
		return nil, fmt.Errorf("bad_exponent")
	}
	return &rsa.PublicKey{N: n, E: eInt}, nil
}

func b64JSON(seg string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(seg)
}
