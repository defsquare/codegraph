module AcmeOrder
  # A place, immutable.
  Point = Struct.new(:lat, :lng) do
    def to_s
      "#{lat},#{lng}"
    end
  end
end
