package domain

type Status string

const (
	StatusOK       Status = "ok"
	StatusDegraded Status = "degraded"
)

type Health struct {
	Status       Status `json:"status"`
	Version      string `json:"version"`
	Build        int    `json:"build"`
	Revision     string `json:"revision"`
	ReleasedAt   string `json:"released_at"`
	Environment  string `json:"environment"`
	SupportEmail string `json:"support_email,omitempty"`
	TermsURL     string `json:"terms_url,omitempty"`
	PrivacyURL   string `json:"privacy_url,omitempty"`
	LicenseLabel string `json:"license_label,omitempty"`
}
