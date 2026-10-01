module github.com/abluva/fabric/connect-agent

go 1.22

require (
	github.com/abluva/fabric/securepack-lease v0.0.0-00010101000000-000000000000
	github.com/hashicorp/yamux v0.1.2
)

require (
	golang.org/x/crypto v0.17.0 // indirect
	golang.org/x/sys v0.15.0 // indirect
)

replace github.com/abluva/fabric/securepack-lease => ../securepack-lease
