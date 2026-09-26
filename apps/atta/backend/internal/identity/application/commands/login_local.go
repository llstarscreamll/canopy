package commands

import (
	"context"
	"strings"

	"github.com/atta/internal/identity/application/ports"
	"github.com/atta/internal/platform/auth"
)

type LoginLocalCommand struct {
	repo         ports.Repository
	sessions     *sessionIssuer
	localEnabled bool
}

func NewLoginLocalCommand(
	repo ports.Repository,
	tokenGen *auth.TokenGenerator,
	refreshStore auth.RefreshTokenStore,
	appEnv string,
	operatorEmails []string,
) *LoginLocalCommand {
	return &LoginLocalCommand{
		repo:         repo,
		sessions:     newSessionIssuer(repo, tokenGen, refreshStore, operatorEmails),
		localEnabled: appEnv == "local",
	}
}

func (cmd *LoginLocalCommand) Execute(ctx context.Context, email, password string) (*auth.TokenPair, error) {
	if !cmd.localEnabled {
		return nil, ErrLocalAuthDisabled
	}

	user, err := cmd.repo.FindUserByEmail(ctx, strings.TrimSpace(strings.ToLower(email)))
	if err != nil {
		return nil, ErrInvalidCredentials
	}

	identity, err := cmd.repo.FindUserIdentityByProvider(ctx, user.ID, "local")
	if err != nil {
		return nil, ErrInvalidCredentials
	}

	if err := auth.CheckPassword(identity.ProviderID, password); err != nil {
		return nil, ErrInvalidCredentials
	}

	return cmd.sessions.issue(ctx, user)
}
