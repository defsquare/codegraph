# A monkey patch: the VM defined `String` first, so this body is a reopening.
class String
  def blank?
    strip.empty?
  end
end
