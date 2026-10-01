// Package enroll defines the pluggable "how may this Agent instance
// enroll" contract, separate from identity.Store's "where does identity
// live" contract. The two are independent axes: a Kubernetes Agent could
// enroll via a bootstrap token (today) or via its pod's projected
// ServiceAccount token / cloud workload identity (future, no shared
// secret to distribute at all) -- and either way, the resulting leaf
// still needs somewhere to live, which is identity.Store's job, not this
// package's.
//
// Naming note: this repo's existing vocabulary for "prove you may join
// and get a leaf cert" is already "enroll" -- POST /v1/agents/enroll,
// enroll_starting/enroll_submitted log lines, L3-AGT-02's "CSR-in-enroll."
// This package and its Method interface use that name rather than
// "join" so there is exactly one word for the concept in this codebase.
//
// Today: bootstrap.Method (opaque token, shipped in the install Secret).
// Future seam (see Architecture-Resolutions.md / PRODUCTION-READINESS.md
// "Cloud-native join"): oci.Method, awsiam.Method, k8soidc.Method, each
// implementing Method by exchanging a platform-native attestation for the
// same Enroll() call bootstrap.Method already makes -- main.go's control
// flow does not change when a new Method is added.
package enroll

import "context"

// Credentials is what a Method proves to the control plane's
// POST /v1/agents/enroll -- either a bootstrap token today, or an
// attestation payload (a signed cloud identity document, a projected
// ServiceAccount JWT, etc.) for a future Method. The enroll HTTP call
// itself is shared (see bootstrap.Enroll) and only cares about these two
// fields plus which method produced them; it does not need a type switch
// over every current and future Method.
type Credentials struct {
	// Method is sent as the enroll request's join_method field so the
	// control plane can apply the right verification path server-side.
	// "bootstrap_token" for the shipped Method. (Wire field name stays
	// join_method for now -- see bootstrap.Enroll's comment on why
	// renaming the wire field is a separate, deliberate decision from
	// renaming this Go package.)
	Method string
	// BootstrapToken is set when Method == "bootstrap_token". Future
	// Methods that send an attestation document instead would add their
	// own field here (or the control plane's enroll handler grows a
	// second optional field) -- this struct is additive, not something
	// every Method must populate every field of.
	BootstrapToken string
}

// Method produces enrollment Credentials. Implementations decide how
// they obtain proof of "this instance may enroll for tenant X" -- a
// pre-provisioned token (bootstrap.Method) or a platform-native
// attestation (future Methods) -- but never talk to the control plane
// themselves; that stays centralized in bootstrap.Enroll so authz
// changes (new headers, retry policy, etc.) happen in one place
// regardless of which Method is configured.
type Method interface {
	// Credentials returns what to present to enroll. Returning an error
	// means "this Method has nothing to offer right now" (e.g. bootstrap
	// token env var unset) -- main.go treats that as "cannot enroll",
	// same as today's fail-closed behavior.
	Credentials(ctx context.Context) (Credentials, error)
}
