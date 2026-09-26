package health

import (
	"net/http"
	"strings"

	httpV1 "github.com/atta/internal/health/adapters/http/v1"
	healthRepo "github.com/atta/internal/health/adapters/repository/postgres"
	"github.com/atta/internal/health/application"
	"github.com/atta/internal/health/application/queries"
	"github.com/atta/internal/platform/config"
	"github.com/jackc/pgx/v5/pgxpool"
)

func NewApplication(db *pgxpool.Pool, cfg config.Config) *application.Application {
	if db == nil {
		panic("database pool is required")
	}

	repo := healthRepo.NewPostgresRepository(db)
	about := queries.AboutInfo{
		Environment:  cfg.AppEnv,
		SupportEmail: resolveSupportEmail(cfg),
		TermsURL:     cfg.TermsURL,
		PrivacyURL:   cfg.PrivacyURL,
		LicenseLabel: cfg.LicenseLabel,
	}

	return &application.Application{
		Queries: application.Queries{
			CheckHealth: queries.NewCheckHealthQuery(repo, about),
		},
	}
}

func resolveSupportEmail(cfg config.Config) string {
	if email := strings.TrimSpace(cfg.SupportEmail); email != "" {
		return email
	}
	if cfg.AppEnv == config.AppEnvLocal {
		return "soporte@atta.com"
	}
	return ""
}

func NewHTTPHandler(mux *http.ServeMux, app *application.Application, cfg config.Config) *httpV1.Router {
	if mux == nil {
		panic("http mux is required")
	}

	if app == nil {
		panic("health application is required")
	}

	controller := httpV1.NewController(*app)
	handler := httpV1.NewRouter(controller)
	handler.Register(mux, cfg)

	return handler
}
