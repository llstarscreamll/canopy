package commands

import (
	"context"
	"strings"

	"github.com/atta/internal/identity/application/ports"
	"github.com/atta/internal/identity/domain"
	"github.com/atta/internal/platform/auth"
	"github.com/atta/internal/platform/id"
)

type RegisterLocalCommand struct {
	repo         ports.Repository
	sessions     *sessionIssuer
	localEnabled bool
}

func NewRegisterLocalCommand(
	repo ports.Repository,
	tokenGen *auth.TokenGenerator,
	refreshStore auth.RefreshTokenStore,
	appEnv string,
	operatorEmails []string,
) *RegisterLocalCommand {
	return &RegisterLocalCommand{
		repo:         repo,
		sessions:     newSessionIssuer(repo, tokenGen, refreshStore, operatorEmails),
		localEnabled: appEnv == "local",
	}
}

func (cmd *RegisterLocalCommand) Execute(ctx context.Context, email, password string) (*auth.TokenPair, error) {
	if !cmd.localEnabled {
		return nil, ErrLocalAuthDisabled
	}
	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" || !strings.Contains(email, "@") {
		return nil, ErrInvalidEmail
	}
	hashed, err := auth.HashPassword(password)
	if err != nil {
		return nil, err
	}

	user := domain.NewUser(id.NewULID(), email, "Local", "User", "")
	if err := cmd.repo.CreateUser(ctx, user); err != nil {
		return nil, err
	}

	identity := domain.NewUserIdentity(id.NewULID(), user.ID, "local", hashed)
	if err := cmd.repo.CreateUserIdentity(ctx, identity); err != nil {
		return nil, err
	}

	return cmd.sessions.issue(ctx, user)
}
