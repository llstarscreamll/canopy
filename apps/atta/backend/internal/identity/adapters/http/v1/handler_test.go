package v1

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAuthAttemptLimit(t *testing.T) {
	require.Equal(t, authRateLimitLocal, authAttemptLimit("local"))
	require.Equal(t, authRateLimit, authAttemptLimit("staging"))
	require.Equal(t, authRateLimit, authAttemptLimit("production"))
}
