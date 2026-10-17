ALTER TABLE "audit_log" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_log_business_created_seq_idx" ON "audit_log" USING btree ("business_id","created_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_movements_business_item_idx" ON "stock_movements" USING btree ("business_id","item_id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_low_stock_nonneg" CHECK ("items"."low_stock_milli" is null or "items"."low_stock_milli" >= 0);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_unit_cost_nonneg" CHECK ("stock_movements"."unit_cost_cents" is null or "stock_movements"."unit_cost_cents" >= 0);