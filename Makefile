.PHONY: up down test logs reset

up:        ## Build and start the app at http://localhost:8000
	docker compose up -d --build
	@echo "Open http://localhost:8000"

down:      ## Stop the app (data is kept)
	docker compose down

reset:     ## Stop the app and delete its data
	docker compose down -v

test:      ## Run the backend tests
	docker compose exec -T app python -m pytest -q

logs:
	docker compose logs -f app
