#!/usr/bin/env bash
# A small Rails-shaped Ruby repository with a history.
set -euo pipefail
mkdir -p app/controllers app/models app/jobs config
cat > Gemfile <<'RUBY'
source "https://rubygems.org"
gem "rails", "~> 7.1"
gem "sidekiq"
RUBY
cat > app/controllers/orders_controller.rb <<'RUBY'
class OrdersController < ApplicationController
  before_action :load_order, only: :show

  def show
    render json: @order
  end

  def create
    order = Order.place(params.require(:sku), params.require(:quantity).to_i)
    ShipOrderJob.perform_later(order.id)
    render json: order, status: :created
  end

  private

  def load_order
    @order = Order.find(params[:id])
  end
end
RUBY
cat > app/controllers/application_controller.rb <<'RUBY'
class ApplicationController < ActionController::Base
end
RUBY
cat > app/models/order.rb <<'RUBY'
class Order < ApplicationRecord
  validates :quantity, numericality: { greater_than: 0 }

  def self.place(sku, quantity)
    create!(sku: sku, quantity: quantity, state: "placed")
  end
end
RUBY
cat > app/models/application_record.rb <<'RUBY'
class ApplicationRecord < ActiveRecord::Base
  primary_abstract_class
end
RUBY
cat > app/jobs/ship_order_job.rb <<'RUBY'
class ShipOrderJob < ApplicationJob
  def perform(order_id)
    Order.find(order_id).update!(state: "shipped")
  end
end
RUBY
cat > config/routes.rb <<'RUBY'
Rails.application.routes.draw do
  resources :orders, only: %i[show create]
end
RUBY
git init -q . && git -c user.name=dev -c user.email=dev@example.invalid add . \
  && git -c user.name=dev -c user.email=dev@example.invalid commit -qm "Initial import"
