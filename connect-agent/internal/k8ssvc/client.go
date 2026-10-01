// Package k8ssvc is a minimal, dependency-free client for reconciling
// exactly one Kubernetes resource kind (Service) from inside the cluster
// the Agent itself runs in, using the pod's own in-cluster ServiceAccount
// credentials.
//
// Deliberately hand-rolled instead of importing k8s.io/client-go: this
// repo's Agent is a small, minimal-dependency binary (previously only
// hashicorp/yamux), and client-go's transitive dependency tree is large
// relative to the one narrow operation actually needed here -- reconcile
// one named Service's ports/selector/internalTrafficPolicy. See the
// "no Kubernetes Service routing exists for more than one registration per
// tenant" bug write-up for why this exists at all.
package k8ssvc

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	saDir         = "/var/run/secrets/kubernetes.io/serviceaccount"
	defaultToken  = saDir + "/token"
	defaultCACert = saDir + "/ca.crt"
	namespacePath = saDir + "/namespace"
)

// InCluster reports whether this process appears to be running inside a
// Kubernetes pod with a mounted ServiceAccount token -- the only
// environment this client supports. Callers should check this (or just
// call NewInClusterClient and handle its error) before enabling Service
// management, and fail closed -- log + disable, never crash the Agent's
// actual tunnel/StreamOpen path -- if management was requested but this is
// false (e.g. VM/ECS substrates, or a customer who hasn't granted the RBAC
// yet).
func InCluster() bool {
	_, err := os.Stat(defaultToken)
	return err == nil
}

// Namespace returns the namespace this pod is running in, read from the
// projected ServiceAccount volume Kubernetes always mounts. Empty if not
// in-cluster.
func Namespace() string {
	b, err := os.ReadFile(namespacePath)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// ObjectMeta is the narrow subset of Kubernetes' metadata this client
// reads/writes.
type ObjectMeta struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

// ServicePort mirrors corev1.ServicePort's fields this client sets.
// TargetPort is sent as a plain JSON number; the Kubernetes API server's
// IntOrString accepts that form on the wire same as a named string port.
type ServicePort struct {
	Name       string `json:"name,omitempty"`
	Protocol   string `json:"protocol,omitempty"`
	Port       int32  `json:"port"`
	TargetPort int32  `json:"targetPort,omitempty"`
}

// ServiceSpec mirrors corev1.ServiceSpec's fields this client sets. Never
// sets (or reads) ClusterIP/ClusterIPs/other server-assigned fields --
// EnsureService's merge-patch update deliberately never touches them, see
// its doc comment.
type ServiceSpec struct {
	Type                  string            `json:"type,omitempty"`
	Selector              map[string]string `json:"selector,omitempty"`
	Ports                 []ServicePort     `json:"ports,omitempty"`
	InternalTrafficPolicy string            `json:"internalTrafficPolicy,omitempty"`
}

// Service is the narrow subset of corev1.Service this client sends/receives.
type Service struct {
	APIVersion string      `json:"apiVersion,omitempty"`
	Kind       string      `json:"kind,omitempty"`
	Metadata   ObjectMeta  `json:"metadata"`
	Spec       ServiceSpec `json:"spec"`
}

// Client talks to the Kubernetes API server for exactly the operations
// reconciling a single Service needs.
type Client struct {
	baseURL   string
	http      *http.Client
	tokenPath string
}

// NewInClusterClient builds a Client from the standard in-cluster
// ServiceAccount mount (KUBERNETES_SERVICE_HOST/PORT env vars + the
// projected token/ca.crt files kubelet always sets up for a pod). Returns
// an error if that mount isn't present -- callers should treat that as
// "Service management unavailable in this environment", not fail the
// whole Agent process over it.
func NewInClusterClient() (*Client, error) {
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, fmt.Errorf("KUBERNETES_SERVICE_HOST/KUBERNETES_SERVICE_PORT not set -- not running in a pod")
	}
	caCert, err := os.ReadFile(defaultCACert)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", defaultCACert, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("no valid certs found in %s", defaultCACert)
	}
	if _, err := os.Stat(defaultToken); err != nil {
		return nil, fmt.Errorf("stat %s: %w", defaultToken, err)
	}
	return &Client{
		baseURL: fmt.Sprintf("https://%s:%s", host, port),
		http: &http.Client{
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
			},
			Timeout: 10 * time.Second,
		},
		tokenPath: defaultToken,
	}, nil
}

// NewClientForTest points a Client at an httptest.Server with a fake token
// file instead of a real in-cluster API server/ServiceAccount mount.
// Exported (only) so other packages' tests -- e.g. watch's -- can exercise
// their own reconcile logic against a fake API server without a real
// cluster; not meant for production use.
func NewClientForTest(baseURL string, httpClient *http.Client, tokenPath string) *Client {
	return &Client{baseURL: baseURL, http: httpClient, tokenPath: tokenPath}
}

// EnsureService reconciles the given Service by name/namespace to exactly
// the desired metadata.labels/annotations + spec.selector/ports/
// internalTrafficPolicy, via a JSON Merge Patch (RFC 7396) if the Service
// already exists, or a full create if it doesn't.
//
// A merge patch is deliberate, not just "simpler than PUT": for the
// non-object fields this reconciler owns (spec.ports is an array,
// spec.internalTrafficPolicy is a string), RFC 7396 replaces them wholesale
// with whatever this call sends -- exactly right for a reconciler that
// recomputes its full desired state every tick, same shape as the DNS
// reconciler's "diff full desired against full actual" pattern. For the
// object fields (metadata.labels/annotations), RFC 7396 merges key-by-key
// instead of replacing the whole map -- which means labels/annotations a
// customer or another controller added outside this reconciler's own keys
// are left alone, not clobbered. Either way, this never reads or sets
// clusterIP/clusterIPs/type/sessionAffinity or any other server-assigned
// field, so there's no GET-then-merge round trip and no
// resourceVersion/optimistic-concurrency handling to get right.
func (c *Client) EnsureService(ctx context.Context, namespace string, desired Service) error {
	patch := map[string]any{
		"metadata": map[string]any{
			"labels":      desired.Metadata.Labels,
			"annotations": desired.Metadata.Annotations,
		},
		"spec": map[string]any{
			"selector":              desired.Spec.Selector,
			"ports":                 desired.Spec.Ports,
			"internalTrafficPolicy": desired.Spec.InternalTrafficPolicy,
		},
	}
	body, err := json.Marshal(patch)
	if err != nil {
		return fmt.Errorf("marshal patch: %w", err)
	}
	path := fmt.Sprintf("/api/v1/namespaces/%s/services/%s", namespace, desired.Metadata.Name)
	status, respBody, err := c.do(ctx, http.MethodPatch, path, "application/merge-patch+json", body)
	if err != nil {
		return err
	}
	switch status {
	case http.StatusOK:
		return nil
	case http.StatusNotFound:
		return c.create(ctx, namespace, desired)
	default:
		return fmt.Errorf("patch service %s/%s: status=%d body=%s", namespace, desired.Metadata.Name, status, string(respBody))
	}
}

func (c *Client) create(ctx context.Context, namespace string, desired Service) error {
	desired.APIVersion = "v1"
	desired.Kind = "Service"
	desired.Metadata.Namespace = namespace
	body, err := json.Marshal(desired)
	if err != nil {
		return fmt.Errorf("marshal service: %w", err)
	}
	path := fmt.Sprintf("/api/v1/namespaces/%s/services", namespace)
	status, respBody, err := c.do(ctx, http.MethodPost, path, "application/json", body)
	if err != nil {
		return err
	}
	// A 409 here means another process created it between our PATCH's 404
	// and this POST -- treat as success, the next tick's PATCH will
	// converge it to our desired state regardless of who created it.
	if status == http.StatusCreated || status == http.StatusOK || status == http.StatusConflict {
		return nil
	}
	return fmt.Errorf("create service %s/%s: status=%d body=%s", namespace, desired.Metadata.Name, status, string(respBody))
}

func (c *Client) do(ctx context.Context, method, path, contentType string, body []byte) (int, []byte, error) {
	tok, err := c.token()
	if err != nil {
		return 0, nil, fmt.Errorf("read service account token: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	respBody, err := io.ReadAll(res.Body)
	if err != nil {
		return 0, nil, err
	}
	return res.StatusCode, respBody, nil
}

// token is re-read from disk on every call rather than cached: Kubernetes
// rotates projected ServiceAccount tokens in place at the same path
// (typically well under their ~1h expiry), and a cached copy would
// eventually start failing auth for no reason a restart would fix. A local
// file read is cheap enough to not need caching here.
func (c *Client) token() (string, error) {
	b, err := os.ReadFile(c.tokenPath)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// SecretMeta mirrors the narrow subset of corev1.Secret metadata this
// client sets.
type SecretMeta struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

// Secret is the narrow subset of corev1.Secret this client sends/receives.
// Data values are base64-encoded automatically by the API server's own
// JSON handling of []byte fields -- Go's encoding/json already does this
// for []byte, so callers pass raw bytes in and get raw bytes back.
type Secret struct {
	APIVersion string            `json:"apiVersion,omitempty"`
	Kind       string            `json:"kind,omitempty"`
	Metadata   SecretMeta        `json:"metadata"`
	Type       string            `json:"type,omitempty"`
	Data       map[string][]byte `json:"data,omitempty"`
}

// GetSecret fetches a Secret by name. Returns (nil, nil) on 404 -- not an
// error -- since "Secret doesn't exist yet" is the expected first-boot
// state for identity storage, not a failure. Callers that need to
// distinguish "doesn't exist" from "transient API error" should check for
// a nil, nil return specifically.
func (c *Client) GetSecret(ctx context.Context, namespace, name string) (*Secret, error) {
	path := fmt.Sprintf("/api/v1/namespaces/%s/secrets/%s", namespace, name)
	status, body, err := c.do(ctx, http.MethodGet, path, "", nil)
	if err != nil {
		return nil, err
	}
	switch status {
	case http.StatusOK:
		var s Secret
		if err := json.Unmarshal(body, &s); err != nil {
			return nil, fmt.Errorf("unmarshal secret %s/%s: %w", namespace, name, err)
		}
		return &s, nil
	case http.StatusNotFound:
		return nil, nil
	default:
		return nil, fmt.Errorf("get secret %s/%s: status=%d body=%s", namespace, name, status, string(body))
	}
}

// EnsureSecret reconciles a Secret's data via merge patch (create if
// missing), same create-then-race-tolerant shape as EnsureService. Used
// by identity/k8ssecret to persist Agent credentials without a
// GET-then-merge round trip for the common case.
func (c *Client) EnsureSecret(ctx context.Context, namespace string, desired Secret) error {
	patch := map[string]any{
		"data": desired.Data,
	}
	if len(desired.Metadata.Labels) > 0 || len(desired.Metadata.Annotations) > 0 {
		patch["metadata"] = map[string]any{
			"labels":      desired.Metadata.Labels,
			"annotations": desired.Metadata.Annotations,
		}
	}
	body, err := json.Marshal(patch)
	if err != nil {
		return fmt.Errorf("marshal secret patch: %w", err)
	}
	path := fmt.Sprintf("/api/v1/namespaces/%s/secrets/%s", namespace, desired.Metadata.Name)
	status, respBody, err := c.do(ctx, http.MethodPatch, path, "application/merge-patch+json", body)
	if err != nil {
		return err
	}
	switch status {
	case http.StatusOK:
		return nil
	case http.StatusNotFound:
		return c.createSecret(ctx, namespace, desired)
	default:
		return fmt.Errorf("patch secret %s/%s: status=%d body=%s", namespace, desired.Metadata.Name, status, string(respBody))
	}
}

func (c *Client) createSecret(ctx context.Context, namespace string, desired Secret) error {
	desired.APIVersion = "v1"
	desired.Kind = "Secret"
	desired.Metadata.Namespace = namespace
	if desired.Type == "" {
		desired.Type = "Opaque"
	}
	body, err := json.Marshal(desired)
	if err != nil {
		return fmt.Errorf("marshal secret: %w", err)
	}
	path := fmt.Sprintf("/api/v1/namespaces/%s/secrets", namespace)
	status, respBody, err := c.do(ctx, http.MethodPost, path, "application/json", body)
	if err != nil {
		return err
	}
	if status == http.StatusCreated || status == http.StatusOK {
		return nil
	}
	if status == http.StatusConflict {
		// Unlike EnsureService's identical-looking 409 tolerance, this
		// case is NOT safe to treat as unconditional success: Service
		// reconciliation runs on every poll tick (watch.go's
		// syncListeners, ~5s), so a 409-loser's own desired state gets
		// applied on the very next tick regardless. Identity Secret
		// writes (SaveCert / SaveAPIToken) are one-shot -- called once
		// per rotation or token refresh, not on a recurring tick -- so a
		// 409-loser that just returns success here would have its own
		// data (the cert/key/token it was asked to persist) silently
		// never actually written anywhere, while its caller (RotateLeaf,
		// cptoken.PullCurrent) believes the save succeeded and moves on.
		// Two Agent-side writers really can race a first-ever create on
		// the same per-node Secret in practice: enroll's SaveCert and
		// cptoken's first PullCurrent->SaveAPIToken can both observe
		// "Secret doesn't exist yet" within the same startup sequence.
		// Follow up with the same merge-patch EnsureSecret already uses
		// for the "already exists" path, so whichever side lost the
		// create race still gets its own data merged onto whatever the
		// winner created.
		patchBody, perr := json.Marshal(map[string]any{"data": desired.Data})
		if perr != nil {
			return fmt.Errorf("marshal secret patch after create race: %w", perr)
		}
		patchPath := fmt.Sprintf("/api/v1/namespaces/%s/secrets/%s", namespace, desired.Metadata.Name)
		pStatus, pBody, perr := c.do(ctx, http.MethodPatch, patchPath, "application/merge-patch+json", patchBody)
		if perr != nil {
			return fmt.Errorf("patch secret after create race: %w", perr)
		}
		if pStatus == http.StatusOK {
			return nil
		}
		return fmt.Errorf("patch secret %s/%s after create race: status=%d body=%s", namespace, desired.Metadata.Name, pStatus, string(pBody))
	}
	return fmt.Errorf("create secret %s/%s: status=%d body=%s", namespace, desired.Metadata.Name, status, string(respBody))
}
