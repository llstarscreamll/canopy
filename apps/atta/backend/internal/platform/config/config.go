package config

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	awsConfig "github.com/atta/internal/platform/awsconfig"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

type Config struct {
	AppEnv                        string    `json:"app_env"`
	DeploymentTarget              string    `json:"deployment_target"`
	Port                          string    `json:"port"`
	DatabaseURL                   string    `json:"database_url"`
	DatabaseDirectURL             string    `json:"database_direct_url"`
	SQSQueueURL                   string    `json:"sqs_queue_url"`
	EventBridgeQueueURL           string    `json:"eventbridge_queue_url"`
	EventBusName                  string    `json:"event_bus_name"`
	S3BucketName                  string    `json:"s3_bucket_name"`
	S3PresignEndpointURL          string    `json:"s3_presign_endpoint_url"`
	MinIOEndpointURL              string    `json:"minio_endpoint_url"`
	RabbitMQURL                   string    `json:"rabbitmq_url"`
	AWSRegion                     string    `json:"aws_region"`
	AWSEndpointURL                string    `json:"aws_endpoint_url"`
	AWSAccessKeyID                string    `json:"aws_access_key_id"`
	AWSSecretAccessKey            string    `json:"aws_secret_access_key"`
	SSMParameterName              string    `json:"ssm_parameter_name"`
	JWTAccessSecret               string    `json:"jwt_access_secret"`
	JWTRefreshSecret              string    `json:"jwt_refresh_secret"`
	AllowedOrigins                string    `json:"allowed_origins"`
	Debug                         bool      `json:"debug"`
	GoogleClientID                string    `json:"google_client_id"`
	GoogleClientSecret            string    `json:"google_client_secret"`
	MicrosoftClientID             string    `json:"microsoft_client_id"`
	MicrosoftClientSecret         string    `json:"microsoft_client_secret"`
	GeminiAPIKey                  string    `json:"gemini_api_key"`
	GeminiModel                   string    `json:"gemini_model"`
	GeminiEndpoint                string    `json:"gemini_endpoint"`
	InboxCredentialsEncryptionKey string    `json:"inbox_credentials_encryption_key"`
	TenantSecretsEncryptionKey    string    `json:"tenant_secrets_encryption_key"`
	MessagingAttestationSecret    string    `json:"messaging_attestation_secret"`
	FrontendURL                   string    `json:"frontend_url"`
	BackendURL                    string    `json:"backend_url"`
	SupportEmail                  string    `json:"support_email"`
	TermsURL                      string    `json:"terms_url"`
	PrivacyURL                    string    `json:"privacy_url"`
	LicenseLabel                  string    `json:"license_label"`
	PlatformOperatorEmails        []string  `json:"-"`
	JWT                           JWTConfig `json:"-"`
}

type JWTConfig struct {
	AccessSecret  string
	RefreshSecret string
	AccessTTL     time.Duration
	RefreshTTL    time.Duration
}

const (
	DeploymentTargetAWS    = "aws"
	DeploymentTargetOnPrem = "onprem"

	AppEnvLocal      = "local"
	AppEnvStaging    = "staging"
	AppEnvProduction = "production"
)

func Load(ctx context.Context) (Config, error) {
	deploymentTarget := getEnv("DEPLOYMENT_TARGET", DeploymentTargetOnPrem)
	if deploymentTarget != DeploymentTargetAWS && deploymentTarget != DeploymentTargetOnPrem {
		return Config{}, fmt.Errorf("invalid DEPLOYMENT_TARGET: %q", deploymentTarget)
	}

	rawAppEnv, ok := os.LookupEnv("APP_ENV")
	if !ok || strings.TrimSpace(rawAppEnv) == "" {
		return Config{}, fmt.Errorf("APP_ENV is required (local|staging|production)")
	}
	appEnv, err := NormalizeAppEnv(rawAppEnv)
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		AppEnv:                 appEnv,
		DeploymentTarget:       deploymentTarget,
		Port:                   getEnv("PORT", "8080"),
		AWSRegion:              getEnv("AWS_REGION", "us-east-1"),
		AWSEndpointURL:         os.Getenv("AWS_ENDPOINT_URL"),
		MinIOEndpointURL:       os.Getenv("MINIO_ENDPOINT_URL"),
		RabbitMQURL:            os.Getenv("RABBITMQ_URL"),
		S3PresignEndpointURL:   os.Getenv("S3_PRESIGN_ENDPOINT_URL"),
		AWSAccessKeyID:         os.Getenv("AWS_ACCESS_KEY_ID"),
		AWSSecretAccessKey:     os.Getenv("AWS_SECRET_ACCESS_KEY"),
		AllowedOrigins:         getEnv("ALLOWED_ORIGINS", "https://app.atta.dev,http://app.atta.dev,http://localhost:4200"),
		FrontendURL:            getEnv("FRONTEND_URL", "https://app.atta.dev"),
		BackendURL:             getEnv("BACKEND_URL", "https://app.atta.dev"),
		SupportEmail:           strings.TrimSpace(os.Getenv("SUPPORT_EMAIL")),
		TermsURL:               strings.TrimSpace(os.Getenv("TERMS_URL")),
		PrivacyURL:             strings.TrimSpace(os.Getenv("PRIVACY_URL")),
		LicenseLabel:           getEnv("LICENSE_LABEL", "Software propietario"),
		PlatformOperatorEmails: parseCSVList(os.Getenv("PLATFORM_OPERATOR_EMAILS")),
	}

	cfg.Debug = getEnvAsBool("DEBUG", cfg.AppEnv == AppEnvLocal)

	if cfg.DeploymentTarget == DeploymentTargetAWS {
		cfg.SSMParameterName = os.Getenv("SSM_PARAMETER_NAME")
		if cfg.SSMParameterName == "" {
			return cfg, fmt.Errorf("SSM_PARAMETER_NAME is required when DEPLOYMENT_TARGET=aws")
		}
		awsCfg, err := awsConfig.Load(ctx, cfg.AWSRegion, cfg.AWSEndpointURL, cfg.AWSAccessKeyID, cfg.AWSSecretAccessKey)
		if err != nil {
			return cfg, fmt.Errorf("load aws config for ssm: %w", err)
		}
		if err := loadSSMSecrets(ctx, awsCfg, cfg.AWSEndpointURL, &cfg); err != nil {
			return cfg, fmt.Errorf("load ssm secrets: %w", err)
		}
		// Prefer Lambda env for channel + about metadata over SSM zeros / legacy values.
		if envApp := strings.TrimSpace(os.Getenv("APP_ENV")); envApp != "" {
			cfg.AppEnv = envApp
		}
		normalized, normErr := NormalizeAppEnv(cfg.AppEnv)
		if normErr != nil {
			return cfg, normErr
		}
		cfg.AppEnv = normalized
		applyAboutEnvOverrides(&cfg)
	}

	// Fallback to env vars
	if cfg.DatabaseURL == "" {
		cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	}
	if cfg.DatabaseDirectURL == "" {
		cfg.DatabaseDirectURL = os.Getenv("DATABASE_DIRECT_URL")
	}
	if cfg.RabbitMQURL == "" {
		cfg.RabbitMQURL = os.Getenv("RABBITMQ_URL")
	}
	if cfg.MinIOEndpointURL == "" {
		cfg.MinIOEndpointURL = os.Getenv("MINIO_ENDPOINT_URL")
	}
	if cfg.SQSQueueURL == "" {
		cfg.SQSQueueURL = os.Getenv("SQS_QUEUE_URL")
	}
	if cfg.EventBridgeQueueURL == "" {
		cfg.EventBridgeQueueURL = os.Getenv("EVENTBRIDGE_QUEUE_URL")
	}
	if cfg.S3BucketName == "" {
		cfg.S3BucketName = os.Getenv("S3_BUCKET_NAME")
	}
	if cfg.EventBusName == "" {
		cfg.EventBusName = os.Getenv("EVENT_BUS_NAME")
	}

	if cfg.DeploymentTarget == DeploymentTargetOnPrem {
		loadOnPremEnv(&cfg)
	}

	if cfg.DatabaseURL == "" {
		panic("DATABASE_URL is required (from secrets or env)")
	}
	if cfg.DatabaseDirectURL == "" {
		cfg.DatabaseDirectURL = cfg.DatabaseURL
	}
	if cfg.InboxCredentialsEncryptionKey == "" {
		panic("inbox_credentials_encryption_key is required from secrets or env")
	}
	if cfg.TenantSecretsEncryptionKey == "" {
		panic("tenant_secrets_encryption_key is required from secrets or env")
	}
	if cfg.EventBusName == "" && cfg.DeploymentTarget == DeploymentTargetAWS {
		panic("EVENT_BUS_NAME is required for aws deployment")
	}
	if cfg.S3BucketName == "" {
		panic("S3_BUCKET_NAME is required (from SSM or env)")
	}
	if cfg.DeploymentTarget == DeploymentTargetOnPrem && cfg.RabbitMQURL == "" {
		panic("RABBITMQ_URL is required for onprem deployment")
	}
	if cfg.DeploymentTarget == DeploymentTargetOnPrem && (cfg.AWSAccessKeyID == "" || cfg.AWSSecretAccessKey == "") {
		panic("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for onprem object storage")
	}
	if cfg.GeminiAPIKey == "" {
		panic("GEMINI_API_KEY is required (from secrets or env)")
	}

	if cfg.MessagingAttestationSecret == "" && cfg.AppEnv == AppEnvLocal {
		cfg.MessagingAttestationSecret = localMessagingAttestation
	}

	if err := validateSecurityConfig(cfg); err != nil {
		panic(err.Error())
	}

	accessSecret := firstNonEmpty(os.Getenv("JWT_ACCESS_SECRET"), cfg.JWTAccessSecret)
	if accessSecret == "" {
		if cfg.AppEnv == AppEnvLocal {
			accessSecret = "local-dev-access-secret-do-not-use-in-prod"
		} else {
			panic("JWT_ACCESS_SECRET is required")
		}
	}

	refreshSecret := firstNonEmpty(os.Getenv("JWT_REFRESH_SECRET"), cfg.JWTRefreshSecret)
	if refreshSecret == "" {
		if cfg.AppEnv == AppEnvLocal {
			refreshSecret = "local-dev-refresh-secret-do-not-use-in-prod"
		} else {
			panic("JWT_REFRESH_SECRET is required")
		}
	}

	cfg.JWT = JWTConfig{
		AccessSecret:  accessSecret,
		RefreshSecret: refreshSecret,
		AccessTTL:     15 * time.Minute,
		RefreshTTL:    7 * 24 * time.Hour,
	}

	return cfg, nil
}

func loadOnPremEnv(cfg *Config) {
	if cfg.GoogleClientID == "" {
		cfg.GoogleClientID = os.Getenv("GOOGLE_CLIENT_ID")
	}
	if cfg.GoogleClientSecret == "" {
		cfg.GoogleClientSecret = os.Getenv("GOOGLE_CLIENT_SECRET")
	}
	if cfg.MicrosoftClientID == "" {
		cfg.MicrosoftClientID = os.Getenv("MICROSOFT_CLIENT_ID")
	}
	if cfg.MicrosoftClientSecret == "" {
		cfg.MicrosoftClientSecret = os.Getenv("MICROSOFT_CLIENT_SECRET")
	}
	if cfg.GeminiAPIKey == "" {
		cfg.GeminiAPIKey = os.Getenv("GEMINI_API_KEY")
	}
	if cfg.GeminiModel == "" {
		cfg.GeminiModel = getEnv("GEMINI_MODEL", "gemini-2.0-flash")
	}
	if cfg.GeminiEndpoint == "" {
		cfg.GeminiEndpoint = getEnv("GEMINI_ENDPOINT", "https://generativelanguage.googleapis.com")
	}
	if cfg.InboxCredentialsEncryptionKey == "" {
		cfg.InboxCredentialsEncryptionKey = os.Getenv("INBOX_CREDENTIALS_ENCRYPTION_KEY")
	}
	if cfg.TenantSecretsEncryptionKey == "" {
		cfg.TenantSecretsEncryptionKey = os.Getenv("TENANT_SECRETS_ENCRYPTION_KEY")
	}
	if cfg.MessagingAttestationSecret == "" {
		cfg.MessagingAttestationSecret = os.Getenv("MESSAGING_ATTESTATION_SECRET")
	}
}

var (
	exampleInboxCredentialsKey = "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI="
	exampleTenantSecretsKey    = "YXR0YS1sb2NhbC1zZWNyZXRzLWtleS0zMmJ5dGVzISE="
	localMessagingAttestation  = "local-dev-messaging-attestation-secret"
)

func validateSecurityConfig(cfg Config) error {
	if cfg.MessagingAttestationSecret == "" {
		return fmt.Errorf("MESSAGING_ATTESTATION_SECRET is required")
	}
	if cfg.AppEnv == AppEnvLocal {
		return nil
	}
	if strings.TrimSpace(cfg.SupportEmail) == "" {
		return fmt.Errorf("SUPPORT_EMAIL is required outside APP_ENV=local")
	}
	if cfg.InboxCredentialsEncryptionKey == exampleInboxCredentialsKey {
		return fmt.Errorf("INBOX_CREDENTIALS_ENCRYPTION_KEY must not use the example value outside APP_ENV=local")
	}
	if cfg.TenantSecretsEncryptionKey == exampleTenantSecretsKey {
		return fmt.Errorf("TENANT_SECRETS_ENCRYPTION_KEY must not use the example value outside APP_ENV=local")
	}
	if cfg.MessagingAttestationSecret == localMessagingAttestation {
		return fmt.Errorf("MESSAGING_ATTESTATION_SECRET must not use the local default outside APP_ENV=local")
	}
	return nil
}

func applyAboutEnvOverrides(cfg *Config) {
	if email := strings.TrimSpace(os.Getenv("SUPPORT_EMAIL")); email != "" {
		cfg.SupportEmail = email
	}
	if terms := strings.TrimSpace(os.Getenv("TERMS_URL")); terms != "" {
		cfg.TermsURL = terms
	}
	if privacy := strings.TrimSpace(os.Getenv("PRIVACY_URL")); privacy != "" {
		cfg.PrivacyURL = privacy
	}
	if label := strings.TrimSpace(os.Getenv("LICENSE_LABEL")); label != "" {
		cfg.LicenseLabel = label
	}
}

// NormalizeAppEnv returns the canonical channel: local, staging, or production.
// Empty or unknown values are an error (no aliases).
func NormalizeAppEnv(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case AppEnvLocal:
		return AppEnvLocal, nil
	case AppEnvStaging:
		return AppEnvStaging, nil
	case AppEnvProduction:
		return AppEnvProduction, nil
	case "":
		return "", fmt.Errorf("APP_ENV is required (local|staging|production)")
	default:
		return "", fmt.Errorf("APP_ENV must be local|staging|production, got %q", raw)
	}
}

func loadSSMSecrets(ctx context.Context, awsCfg aws.Config, endpointURL string, cfg *Config) error {
	var client *ssm.Client
	if endpointURL != "" {
		client = ssm.NewFromConfig(awsCfg, func(o *ssm.Options) {
			o.BaseEndpoint = &endpointURL
		})
	} else {
		client = ssm.NewFromConfig(awsCfg)
	}

	param, err := client.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           &cfg.SSMParameterName,
		WithDecryption: aws.Bool(true),
	})
	if err != nil {
		return err
	}

	if param.Parameter == nil || param.Parameter.Value == nil {
		return fmt.Errorf("parameter %s is empty", cfg.SSMParameterName)
	}

	return json.Unmarshal([]byte(*param.Parameter.Value), cfg)
}

func parseCSVList(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		normalized := strings.ToLower(strings.TrimSpace(part))
		if normalized != "" {
			out = append(out, normalized)
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func getEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func getEnvAsBool(key string, fallback bool) bool {
	value, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}

	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}

	return parsed
}

// DirectDatabaseURL is the non-pooled Postgres URL. Neon CREATE DATABASE and
// golang-migrate need it; Lambda request paths use DatabaseURL (PgBouncer).
func (c Config) DirectDatabaseURL() string {
	if strings.TrimSpace(c.DatabaseDirectURL) != "" {
		return c.DatabaseDirectURL
	}
	return c.DatabaseURL
}
