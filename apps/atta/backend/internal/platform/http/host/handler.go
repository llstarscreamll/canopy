package host

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	catalogModule "github.com/atta/internal/catalog"
	connectionsModule "github.com/atta/internal/connections"
	entitlementsModule "github.com/atta/internal/entitlements"
	filesModule "github.com/atta/internal/files"
	"github.com/atta/internal/health"
	identityModule "github.com/atta/internal/identity"
	inboxModule "github.com/atta/internal/inbox"
	invoicesModule "github.com/atta/internal/invoices"
	legalentitiesModule "github.com/atta/internal/legalentities"
	partiesModule "github.com/atta/internal/parties"
	"github.com/atta/internal/platform"
	"github.com/atta/internal/platform/auth"
	platformCrypto "github.com/atta/internal/platform/crypto"
	"github.com/atta/internal/platform/events"
	"github.com/atta/internal/platform/tenant"
	rbacModule "github.com/atta/internal/rbac"
	secretsModule "github.com/atta/internal/secrets"
	tenantModule "github.com/atta/internal/tenant"
)

func New(deps *platform.Dependencies) (http.Handler, error) {
	if deps == nil {
		return nil, fmt.Errorf("platform dependencies are required")
	}

	cfg := deps.Config
	pool := deps.ControlDB
	tenantsDbRegistry := deps.TenantRegistry
	mux := http.NewServeMux()

	healthApp := health.NewApplication(pool, cfg)
	health.NewHTTPHandler(mux, healthApp, cfg)

	tokenGen := auth.NewTokenGenerator(cfg.JWT.AccessSecret, cfg.JWT.RefreshSecret, cfg.JWT.AccessTTL, cfg.JWT.RefreshTTL)
	authMiddleware := func(next http.Handler) http.Handler {
		return auth.Middleware(tokenGen)(tenant.RequireMembership(tenantsDbRegistry, cfg.Debug)(next))
	}

	identityApp := identityModule.NewApplication(cfg, pool, tenantsDbRegistry, tokenGen)
	identityModule.NewHTTPHandler(mux, identityApp, pool, tenantsDbRegistry, authMiddleware, cfg)

	entitlementsApp := entitlementsModule.NewApplication(pool)

	migrationsDir := os.Getenv("TENANT_MIGRATIONS_DIR")
	if migrationsDir == "" {
		migrationsDir = "migrations/tenant"
		if _, err := os.Stat(migrationsDir); os.IsNotExist(err) {
			migrationsDir = "apps/atta/backend/migrations/tenant"
		}
	}
	organizationApp := tenantModule.NewApplication(pool, cfg.DirectDatabaseURL(), migrationsDir, entitlementsApp)
	tenantModule.NewHTTPHandler(mux, organizationApp, authMiddleware, cfg)
	entitlementsModule.NewHTTPHandler(
		mux,
		entitlementsApp,
		identityModule.NewOperatorDirectory(identityApp),
		tenantModule.NewDirectory(organizationApp),
		authMiddleware,
		cfg,
	)

	if cfg.S3BucketName != "" {
		filesApp := filesModule.NewApplication(deps.FileStore)
		filesModule.NewHTTPHandler(mux, filesApp, authMiddleware, cfg)
	} else {
		log.Printf("file upload routes disabled: s3_bucket_name is empty")
	}

	var connectionsEventBus events.EventBus = deps.EventBus

	cipher, err := platformCrypto.NewAESCipherFromBase64Key(cfg.InboxCredentialsEncryptionKey)
	if err != nil {
		return nil, fmt.Errorf("new cipher: %w", err)
	}
	connectionsApp := connectionsModule.NewApplication(tenantsDbRegistry, cipher)
	connectionsService := connectionsModule.NewInternalService(connectionsApp)
	connectionsModule.NewHTTPHandler(mux, cfg, tenantsDbRegistry, cipher, tokenGen, cipher, connectionsEventBus, authMiddleware, entitlementsApp)

	if cfg.GoogleClientID != "" && cfg.GoogleClientSecret != "" && cfg.S3BucketName == "" {
		return nil, fmt.Errorf("s3 bucket name is required for inbox sync")
	}

	inboxApp := inboxModule.NewApplication(
		cfg,
		connectionsService,
		deps.EventBus,
		deps.FileStore,
		tenantsDbRegistry,
		deps.TaskQueue,
	)
	inboxModule.NewHTTPHandler(mux, inboxApp, authMiddleware, cfg, entitlementsApp)

	rbacService := rbacModule.NewService(tenantsDbRegistry)
	rbacModule.NewHTTPHandler(mux, rbacService, authMiddleware, cfg)

	secretsCipher, err := platformCrypto.NewAESCipherFromBase64Key(cfg.TenantSecretsEncryptionKey)
	if err != nil {
		return nil, fmt.Errorf("new tenant secrets cipher: %w", err)
	}
	secretsApp := secretsModule.NewApplication(tenantsDbRegistry, secretsCipher)
	secretsModule.NewHTTPHandler(mux, secretsApp, rbacService, authMiddleware, cfg)

	partiesApp := partiesModule.NewApplication(tenantsDbRegistry)
	partiesModule.NewHTTPHandler(mux, partiesApp, authMiddleware, cfg)
	catalogApp := catalogModule.NewApplication(tenantsDbRegistry, deps.TaskQueue, filesModule.NewTenantObjects(deps.FileStore))
	catalogModule.NewHTTPHandler(mux, catalogApp, authMiddleware, cfg)

	legalentitiesApp := legalentitiesModule.NewApplication(tenantsDbRegistry, deps.EventBus)
	legalentitiesModule.NewHTTPHandler(mux, legalentitiesApp, authMiddleware, cfg)

	invoicingApp := invoicesModule.NewApplication(
		cfg,
		deps.EventBus,
		deps.TaskQueue,
		deps.FileStore,
		tenantsDbRegistry,
		secretsModule.NewDocumentPasswordResolver(secretsApp),
		catalogModule.NewInvoiceSupport(catalogApp),
		partiesModule.NewIssuerPartyLookup(partiesApp),
		legalentitiesModule.NewReceiverDirectory(legalentitiesApp),
		inboxModule.NewInvoiceBackfillSource(inboxApp),
	)
	invoicesModule.NewHTTPHandler(mux, invoicingApp, authMiddleware, cfg)
	catalogModule.BindItemLinks(catalogApp, invoicesModule.NewItemLinkSupport(invoicingApp))

	return withSecurityHeaders(withCORS(tenant.Middleware(mux), cfg.AllowedOrigins)), nil
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "credentialless")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func withCORS(next http.Handler, allowedOriginsCSV string) http.Handler {
	allowed := parseOrigins(allowedOriginsCSV)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if match, ok := allowed[origin]; ok {
				w.Header().Set("Access-Control-Allow-Origin", match)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Vary", "Origin")
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Tenant-ID")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func parseOrigins(csv string) map[string]string {
	out := make(map[string]string)
	for _, part := range strings.Split(csv, ",") {
		origin := strings.TrimSpace(part)
		if origin == "" || origin == "*" {
			continue
		}
		out[origin] = origin
	}
	return out
}
