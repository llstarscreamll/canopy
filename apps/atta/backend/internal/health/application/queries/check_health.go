package queries

import (
	"context"

	"github.com/atta/internal/health/application/ports"
	"github.com/atta/internal/health/domain"
	"github.com/atta/internal/platform/product"
)

type AboutInfo struct {
	Environment  string
	SupportEmail string
	TermsURL     string
	PrivacyURL   string
	LicenseLabel string
}

type CheckHealthQuery struct {
	repo  ports.HealthRepository
	about AboutInfo
}

func NewCheckHealthQuery(repo ports.HealthRepository, about AboutInfo) *CheckHealthQuery {
	if repo == nil {
		panic("repo is required")
	}
	return &CheckHealthQuery{repo: repo, about: about}
}

func (q *CheckHealthQuery) Execute(ctx context.Context) domain.Health {
	h := domain.Health{
		Version:      product.Version,
		Build:        product.Build,
		Revision:     product.Revision,
		ReleasedAt:   product.ReleasedAt,
		Environment:  q.about.Environment,
		SupportEmail: q.about.SupportEmail,
		TermsURL:     q.about.TermsURL,
		PrivacyURL:   q.about.PrivacyURL,
		LicenseLabel: q.about.LicenseLabel,
	}
	if err := q.repo.Ping(ctx); err != nil {
		h.Status = domain.StatusDegraded
		return h
	}
	h.Status = domain.StatusOK
	return h
}
