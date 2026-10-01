package session

import "context"

// HandleRevokePushForTest exposes handleRevokePush to the black-box
// session_test package (avoids duplicating yamuxPair/session_test helpers
// across two test packages in this directory).
func HandleRevokePushForTest(h *Handler, tenantID, certFP, cause, kind string) {
	h.handleRevokePush(context.Background(), revokePushBody{
		TenantID:        tenantID,
		CertFingerprint: certFP,
		Cause:           cause,
		Kind:            kind,
	})
}
