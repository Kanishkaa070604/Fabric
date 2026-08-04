// Package relay provides the shared bidirectional byte-copy function used
// by both the outbound listener (customer app → tunnel) and the inbound
// handler (tunnel → customer resource). Extracted to prevent drift between
// the two identical implementations.
package relay

import (
	"io"
	"sync"
)

// CloseWriter is implemented by *net.TCPConn and similar types that
// support half-closing the write direction independently of reads.
type CloseWriter interface {
	CloseWrite() error
}

// Bidirectional copies both directions to completion before returning.
// When one direction reaches EOF, it half-closes the destination's write
// side (if supported) so the other direction can drain its remaining data
// naturally, rather than having the caller's deferred Close() truncate it.
func Bidirectional(a, b io.ReadWriteCloser) {
	var wg sync.WaitGroup
	wg.Add(2)
	copyHalf := func(dst, src io.ReadWriteCloser) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(CloseWriter); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.Close()
		}
	}
	go copyHalf(a, b)
	go copyHalf(b, a)
	wg.Wait()
}
